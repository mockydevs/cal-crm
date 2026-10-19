// The permission matrix: every command the API runs, as every built-in role, over HTTP with
// real sign-in, against a migrated Postgres. Each command is refused, naming its
// permission, exactly where the catalog says the role lacks it, and runs everywhere else.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowEveryone, type ApiRoute } from '@repo/commands';
import {
  contact,
  contactBulkAction,
  contactDetails,
  endpoints,
  apiKeyList,
  appointmentDetail,
  automationView,
  blockedSlot,
  calendarConfiguration,
  deal,
  dealDetails,
  fieldDefinition,
  fieldDeletion,
  fieldFolder,
  customFieldList,
  opportunitySettings,
  fieldFolderList,
  customValue,
  customValueFolder,
  leadSourceRule,
  leadSourceRuleList,
  snippet,
  snippetFolder,
  triggerLink,
  conversation,
  messageTemplate,
  form as formContract,
  messagingSettings,
  phoneNumberSettings,
  phoneSystemSettings,
  call as callRecord,
  recordFields,
  note,
  recordNotes,
  task,
  taskList,
  pipelineConfiguration,
  aiSettings,
  assistantTurnStarted,
  problem,
  proposal,
  contactFacts,
  team,
  userList,
  tagGroup,
  tagConfiguration,
  viewList,
  notificationList,
  notificationPreferences,
  unreadNotificationCount,
  scoreProfile,
  externalTracking,
  scoreRule,
  duplicateSettings,
  contactMergePreview,
  DEFAULT_FORM_DEFINITION,
  emailCampaignMailboxList,
  contactEmailCheckPreview,
  myPermissions,
  objectDefinition,
  association as associationContract,
  permissions,
  permissionsOf,
  type PermissionScope,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { createAiSettingsRoutes } from '@repo/module-ai';
import { createAuthentication, readUserNames, type Authentication } from '@repo/module-auth';
import { marketplaceRoutes } from '@repo/module-tenancy';
import { createGoogleCalendarRoutes } from '@repo/module-calendar';
import { createImportRoutes } from '@repo/module-crm';
import { createIntegrationRoutes } from '@repo/module-integrations';
import { createFiles, createMedia, fileRoutes, mediaRoutes, type Files } from '@repo/module-files';
import { createFormRoutes } from '@repo/module-forms';
import { createSiteRoutes } from '@repo/module-sites';
import {
  createCallRoutes,
  createMailboxRoutes,
  createEmailVerificationRoutes,
  createSmsRoutes,
  createWebchatRoutes,
} from '@repo/module-messaging';
import { createSealingVault, newSecretsKey, parseSecretsPublicKey } from '@repo/module-vault';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import type { LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { COMMERCE_COMMANDS, commerceExamples } from '../test/commerce-fixtures.js';
import {
  MARKETPLACE_INSTALL_COMMANDS,
  MARKETPLACE_PUBLISH_COMMANDS,
  marketplaceExamples,
} from '../test/marketplace-fixtures.js';
import { MEDIA_COMMANDS, mediaExamples } from '../test/media-fixtures.js';
import {
  addCampaignRecords,
  CAMPAIGN_DRAFT_COMMANDS,
  CAMPAIGN_SEND_COMMANDS,
  campaignExamples,
} from '../test/campaign-fixtures.js';
import { googleRouteOptions } from '../test/google-fixtures.js';
import {
  INTEGRATION_COMMANDS,
  integrationConnection,
  integrationRouteOptions,
} from '../test/integration-fixtures.js';
import { REPORTING_COMMANDS, reportingExamples } from '../test/reporting-fixtures.js';
import { SITE_COMMANDS, SITE_ROUTE_OPTIONS, siteExamples } from '../test/sites-fixtures.js';
import { apiRoutes } from './api-routes.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

const PUBLIC_URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

let database: TestDatabase;
let db: Database;
let authentication: Authentication;
let root: string;
let files: Files;
let routes: ApiRoute[];
let server: Server;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  authentication = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
    publicUrl: PUBLIC_URL,
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });
  root = await mkdtemp(join(tmpdir(), 'crm-permissions-'));
  const storage = localStorage({ directory: join(root, 'storage') });
  files = createFiles({
    storage,
    uploadDirectory: join(root, 'uploads'),
    maxBytes: 1024 * 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
  // With a vault, as an install that can keep secrets has: the routes that seal one then
  // run their real commands.
  const sealer = await createSealingVault(
    parseSecretsPublicKey((await newSecretsKey(1)).publicKey),
  );
  // Calls as an install where Phone System says they can be made: until then every request
  // is refused before its command runs anything, which
  // packages/modules/messaging/src/call-lifecycle.int.test.ts proves.
  const callRoutes = createCallRoutes(
    () => Promise.resolve({ available: true, unavailable: null }),
    { files, apiUrl: `${PUBLIC_URL}${API_PREFIX}` },
  );
  const callOperations = new Set(callRoutes.map(({ endpoint }) => endpoint.operationId));
  const verificationRoutes = createEmailVerificationRoutes({
    vault: sealer,
    provider: () => ({
      name: 'emailable',
      verify: () =>
        Promise.resolve({ kind: 'failed', problem: 'unavailable', connectionFailing: false }),
      account: () => Promise.resolve({ kind: 'ok', availableCredits: 20, testMode: true }),
    }),
  });
  const verificationOperations = new Set(
    verificationRoutes.map(({ endpoint }) => endpoint.operationId),
  );
  routes = [
    ...verificationRoutes,
    ...callRoutes,
    // Commerce gets what a running install hands it: the files service, and what a
    // document's public address is made with.
    ...apiRoutes(
      authentication,
      sealer,
      false,
      undefined,
      {
        files,
        publicUrl: PUBLIC_URL,
        publicIntakeSecret: 'a-public-intake-secret-of-32-characters-or-more',
      },
      // Email campaigns are sent only where unsubscribe links can be made.
      { publicUrl: PUBLIC_URL },
    ).filter(
      ({ endpoint }) =>
        !callOperations.has(endpoint.operationId) &&
        !verificationOperations.has(endpoint.operationId),
    ),
    // The consent page's read and decision are offered only with a public address, the
    // OAuth issuer; the routes above are made without one.
    ...marketplaceRoutes({ people: readUserNames, issuer: PUBLIC_URL }).filter(({ endpoint }) =>
      ['readOAuthAuthorization', 'grantOAuthAuthorization'].includes(endpoint.operationId),
    ),
    ...fileRoutes(files, { apiUrl: `${PUBLIC_URL}${API_PREFIX}` }),
    // Media Storage, over the same files and the same storage.
    ...mediaRoutes(
      createMedia({
        storage,
        maxBytes: 1024 * 1024,
        linkSecret: 'a-files-link-secret-of-32-characters-or-more',
        publicUrl: PUBLIC_URL,
        servesPublic: true,
      }),
    ),
    ...createImportRoutes({ files, apiUrl: `${PUBLIC_URL}${API_PREFIX}` }),
    ...createMailboxRoutes(sealer),
    ...createSmsRoutes(sealer, PUBLIC_URL),
    ...createWebchatRoutes(PUBLIC_URL),
    ...createFormRoutes(PUBLIC_URL),
    ...createSiteRoutes(SITE_ROUTE_OPTIONS),
    ...createAiSettingsRoutes({ vault: sealer, localServers: [], people: readUserNames }),
    // Settings → Calendars → Connections, as an install with Google set up has it.
    ...createGoogleCalendarRoutes(googleRouteOptions(sealer)),
    // Settings → Integrations, with the stand-in provider an install's code would register.
    ...createIntegrationRoutes(integrationRouteOptions(sealer)),
  ];
  server = await buildServer({
    config: {
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
      devTenantContext: undefined,
      publicUrl: PUBLIC_URL,
      authentication: undefined,
      trustProxy: [],
      mail: undefined,
      files: undefined,
      vault: undefined,
    },
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes,
    services: { db, authorize: allowEveryone },
    authentication,
    files,
    readinessChecks: {},
  });
});

afterAll(async () => {
  await server.close(1000);
  await authentication.close();
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

interface BuiltInRole {
  readonly scope: PermissionScope;
  readonly key: string;
  /** The commands it may not run, as the permission catalog gives them. */
  readonly refuses: readonly string[];
}

const agencyWork = [
  'agency.require_two_factor',
  'business.create',
  // The prices AI costs are worked out from are the agency's: it rebills by them.
  'ai.set_model_price',
  'ai.remove_model_price',
  // Publishing marketplace apps: the agency publishes them, so a business, where a business
  // user always works, is refused it for where it ran.
  ...MARKETPLACE_PUBLISH_COMMANDS,
];
const teamWork = [
  // Connecting, changing and disconnecting integrations moves the business's credentials
  // (integrations.manage): owners' and admins'.
  ...INTEGRATION_COMMANDS,
  'email_verification.settings',
  'email_verification.connect',
  'email_verification.disconnect',
  'email_verification.test',
  // Funnels, websites, their templates and share bundles, domains and redirects:
  // sites.manage, sites.publish, sites.share and domains.manage are owners' and admins'.
  ...SITE_COMMANDS,
  // Settings → External Tracking: the analytics of the business's websites (sites.manage).
  'external_tracking.update',
  'external_tracking.regenerate',
  // The catalogue, quotes, invoices, payments and their settings: payments.manage is
  // owners' and admins'. Members see them (payments.read) and change none.
  ...COMMERCE_COMMANDS,
  'invoice_reminder.create',
  'invoice_reminder.update',
  'invoice_reminder.delete',
  // Saved reports: reports.manage is owners' and admins'. Members read reports
  // (reports.view) and change none.
  ...REPORTING_COMMANDS,
  // Email campaigns: sending, scheduling, pausing and cancelling one (campaigns.send) and
  // the business's sending ceiling are owners' and admins'. Members write campaigns and
  // test them to themselves (campaigns.manage).
  ...CAMPAIGN_SEND_COMMANDS,
  'field.create',
  'field.update',
  // Settings → Custom Fields: folders are part of configuring fields (fields.manage).
  'field_folder.create',
  'field_folder.rename',
  'field_folder.reorder',
  'field_folder.delete',
  'field.move',
  'field.reorder',
  'field.delete',
  // Settings → Objects: custom objects and associations are admins' in GoHighLevel
  // (objects.manage).
  'object.create',
  'object.update',
  'object.delete',
  'association.create',
  'association.update',
  'association.delete',
  // Settings → Custom Values: the text templates send (templates.manage).
  'custom_value.create',
  'custom_value.update',
  'custom_value.move',
  'custom_value.delete',
  'custom_value.delete_many',
  'custom_value_folder.create',
  'custom_value_folder.rename',
  'custom_value_folder.delete',
  'tag_group.create',
  'tag_group.update',
  'tag_rules.update',
  'tag.update',
  'pipelines.save',
  // The Pipelines page's row menu and the opportunity settings.
  'pipeline.move',
  'pipeline.duplicate',
  'pipeline.delete',
  'opportunity_settings.update',
  'business.update_profile',
  // Business Profile → Contact Deduplication Preferences, and Manage Duplicates' Reject:
  // GoHighLevel gives Manage Duplicates to admins only (contacts.merge).
  'duplicate_settings.update',
  'contact_duplicates.reject',
  // Merging contacts is Manage Duplicates' too, and cannot be undone.
  'contact.merge',
  'team.invite',
  'team.resend_invitation',
  'team.revoke_invitation',
  'team.remove_member',
  'team.add_user',
  'team.update_user',
  'record.purge',
  'mailboxes.connect',
  'mailboxes.check',
  'mailboxes.update_sending',
  'messaging.update_settings',
  'sms.connect',
  'sms.refresh_numbers',
  'sms.register_number',
  // Settings → Phone System: phone.manage is owners' and admins'.
  'phone.update_settings',
  'phone_number.update_settings',
  'phone.set_up_calling',
  'webchat.create_widget',
  'webchat.update_widget',
  'webchat.rotate_widget_key',
  'ai.connect_provider',
  'ai.update_connection',
  'ai.test_connection',
  'ai.remove_connection',
  'ai.update_settings',
  // How much an assistant does on its own: letting it act is for whoever sets up AI.
  'ai.set_autonomy',
  // Settings → Lead Sources: the business's own rules decide what every form's lead is
  // called, so changing them is for whoever manages forms (forms.manage).
  'forms.lead_source_rule.create',
  'forms.lead_source_rule.update',
  'forms.lead_source_rule.delete',
  'forms.lead_source_rule.reorder',
  'forms.create',
  'forms.update',
  'forms.publish',
  'forms.unpublish',
  'forms.archive',
  'forms.restore',
  'forms.discard_submission',
  // A file of contacts at once is for whoever runs the business, not daily work.
  'import.start',
  'import.cancel',
  'calendar.create',
  'calendar.update',
  'calendar.availability.update',
  'calendar.delete',
  'calendar_group.create',
  'calendar_group.rename',
  'calendar_group.delete',
  'calendar.user_availability.update',
  'calendar.blocked_slot.create',
  'calendar.blocked_slot.update',
  'calendar.blocked_slot.delete',
  'automation.create',
  'automation.replace_draft',
  'automation.copy_email_template',
  'automation.enable_email_sync',
  'automation.save_synced_email',
  'automation.patch_draft',
  'automation.test',
  'automation.retry_run',
  'automation.continue_run',
  'automation.publish',
  'automation.pause',
  'automation.resume',
  'automation.rotate_webhook_secret',
  // The webhook secrets a step's headers send: automations.publish, like the signing
  // secret.
  'automation.put_webhook_secret',
  'automation.delete_webhook_secret',
  'automation.create_folder',
  'automation.update_folder',
  'automation.delete_folder',
  'automation.move',
  'automation.delete',
  'automation.restore',
  'template.create',
  'template.update',
  'template.archive',
  'template.restore',
  'template.create_folder',
  'template.update_folder',
  'template.remove_folder',
  'template.move',
  'template.delete',
  'template.duplicate',
  'template.bulk',
  // Conversations → Snippets and Trigger Links: what messages carry (templates.manage).
  'snippet.create',
  'snippet.update',
  'snippet.move',
  'snippet.delete',
  'snippet_folder.create',
  'snippet_folder.rename',
  'snippet_folder.delete',
  'trigger_link.create',
  'trigger_link.update',
  'trigger_link.delete',
  // Settings → Manage Scoring: profile and rule commands.
  'crm.score_rule.create',
  'crm.score_rule.update',
  'crm.score_rule.delete',
  'crm.score_profile.update',
  'crm.score_profile.publish',
];

// Installing a marketplace app grants it permissions, as making a key does.
const keyWork = ['api_key.create', 'api_key.revoke', ...MARKETPLACE_INSTALL_COMMANDS];

/** Daily work: members may do it, viewers may not. */
const contactWork = [
  'email_address.verify',
  'email_address.exclude',
  'email_address.include',
  'email_address.block',
  'email_address.unblock',
  'contact.create',
  'contact.update',
  'contact.trash',
  'contact.restore',
  'contact.assign_owner',
  'contact.add_followers',
  'contact.remove_followers',
  'contact.add_address',
  'contact.update_address',
  'contact.remove_address',
  'contact.set_dnd',
  // Many contacts at once, from the list's selection, and stopping such an action.
  'contact.bulk',
  'contact.bulk.cancel',
  // What the assistant knows about a contact: rewriting or removing a fact.
  'contact_fact.correct',
  'contact_fact.delete',
];
const companyWork = [
  'company.create',
  'company.update',
  'company.trash',
  'company.restore',
  'contact.link_company',
  'contact.unlink_company',
];

/**
 * Working the inbox: assigning, opening and closing, reading, noting and replying. Asking
 * the assistant for a draft is part of replying: a draft is a reply somebody may send.
 */
const conversationWork = [
  'conversation.assign',
  'conversation.set_status',
  'conversation.mark_read',
  // Marking read or unread and starring many at once, from the list's selection.
  'conversation.bulk',
  'conversation.add_note',
  'conversation.reply',
  'ai.request_reply_draft',
  // Filling a snippet in for a contact is part of replying; the manual actions queue is
  // worked by whoever works conversations.
  'snippet.render',
  'manual_action.assign',
  'manual_action.complete',
  'manual_action.skip',
];

/** How the agency's own work is refused in a business (requireAgency, and A1). */
const elsewhere = 'Change this for the whole agency, outside any business.';

const builtInRoles: readonly BuiltInRole[] = [
  { scope: 'agency', key: 'owner', refuses: [] },
  { scope: 'agency', key: 'admin', refuses: [] },
  {
    scope: 'agency',
    key: 'member',
    refuses: [...agencyWork, ...teamWork, ...keyWork, 'view.share', 'view.set_sharing'],
  },
  { scope: 'business', key: 'owner', refuses: agencyWork },
  { scope: 'business', key: 'admin', refuses: agencyWork },
  {
    scope: 'business',
    key: 'member',
    refuses: [...agencyWork, ...teamWork, ...keyWork, 'view.share', 'view.set_sharing'],
  },
  {
    scope: 'business',
    key: 'viewer',
    refuses: [
      ...agencyWork,
      ...teamWork,
      ...keyWork,
      ...contactWork,
      ...companyWork,
      ...conversationWork,
      'call.request',
      'call.hang_up',
      'calls.request_voice_grant',
      'consents.record',
      'field.value.set',
      'field.value.confirm',
      'crm.contact_score.set',
      'deal.create',
      'deal.update',
      'deal.trash',
      'deal.restore',
      // The opportunity dialog: whose a deal is and who it is with.
      'deal.assign_owner',
      'deal.add_followers',
      'deal.remove_followers',
      'deal.set_contacts',
      // Many deals at once, from the list's selection.
      'deal.bulk',
      // Records of custom objects, and relations between records (records.manage).
      'record.create',
      'record.update',
      'record.trash',
      'record.restore',
      'relation.create',
      'relation.delete',
      'file.create',
      // A contact's documents: uploading one and deleting it (files.upload).
      'record.file.attach',
      'record.file.remove',
      // Changing the media library is daily work too (media.manage).
      ...MEDIA_COMMANDS,
      // And so is writing an email campaign (campaigns.manage).
      ...CAMPAIGN_DRAFT_COMMANDS,
      'tag.create',
      // The tags of built-in lead sources, found or made (tags.manage).
      'tag.ensure_lead_sources',
      'tag.assign',
      'tag.remove',
      'note.create',
      'note.update',
      'note.delete',
      'task.create',
      'task.update',
      'task.complete',
      'task.delete',
      // Many tasks at once, from the list's selection.
      'task.bulk',
      // Booking and changing appointments is daily work (appointments.manage).
      'calendar.appointment.book',
      'calendar.appointment.reschedule',
      'calendar.appointment.cancel',
      'calendar.appointment.set_status',
      'calendar.appointment.set_notes',
      // Connecting one's own Google Calendar is for whoever takes bookings.
      'calendar.google.connect',
      'calendar.google.choose_calendars',
      'calendar.google.refresh',
      'calendar.google.disconnect',
      'view.create',
      'view.update',
      'view.delete',
      'view.share',
      'view.unshare',
      'view.set_sharing',
    ],
  },
];

type Call = (
  method: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'DELETE',
  path: string,
  options: { payload: unknown; type?: string; inBusiness: boolean },
) => Promise<LightMyRequestResponse>;

interface Example {
  /** Runs it with an input it accepts, at the agency or in the business, where it works. */
  readonly run: (call: Call, run: number) => Promise<LightMyRequestResponse>;
}

// Every command an API route runs, by name. A route whose command has no example here fails
// the first test, so each new command joins the matrix.
const examples: Readonly<Record<string, Example>> = {
  // Settings → Integrations: connecting only makes the stand-in's consent address; the
  // others change a connected account made for each run.
  'integration.connect': {
    run: (call) => call('POST', '/integrations/standin/connect', { inBusiness: true, payload: {} }),
  },
  'integration.update': {
    run: async (call) => {
      const { id, revision } = await integrationConnection(database, matrixBusiness);
      return call('PATCH', `/integrations/standin/connections/${id}`, {
        inBusiness: true,
        payload: { primary: true, revision },
      });
    },
  },
  'integration.test': {
    run: async (call) => {
      const { id } = await integrationConnection(database, matrixBusiness);
      return call('POST', `/integrations/standin/connections/${id}/test`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  'integration.disconnect': {
    run: async (call) => {
      const { id } = await integrationConnection(database, matrixBusiness);
      return call('DELETE', `/integrations/standin/connections/${id}`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  'email_verification.settings': {
    run: (call) =>
      call('PUT', '/email-verification/settings', {
        inBusiness: true,
        payload: { dailyLimit: 25 },
      }),
  },
  'email_verification.connect': {
    run: (call) =>
      call('PUT', '/email-verification/provider', {
        inBusiness: true,
        payload: { apiKey: 'test_fixture_only' },
      }),
  },
  'email_verification.disconnect': {
    run: (call) =>
      call('DELETE', '/email-verification/provider', { inBusiness: true, payload: undefined }),
  },
  'email_verification.test': {
    run: (call) =>
      call('POST', '/email-verification/provider/test', { inBusiness: true, payload: {} }),
  },
  ...Object.fromEntries(
    (['verify', 'exclude', 'include', 'block', 'unblock'] as const).map((action) => [
      `email_address.${action}`,
      {
        run: async (call: Call) => {
          const { agency_id: agencyId } = await database.as('crm_owner', (sql) =>
            sql.one<{ agency_id: string }>('select agency_id from tenancy.businesses where id=$1', [
              matrixBusiness,
            ]),
          );
          const context = {
            agencyId,
            businessId: matrixBusiness,
            actorKind: 'system' as const,
            correlationId: randomUUID(),
          };
          const contact = await database.fixtures.contact(context, {
            email: `${randomUUID()}@example.test`,
          });
          const identity = await database.withTenant(context, (sql) =>
            sql.one<{ id: string }>('select id from crm.contact_identities where contact_id=$1', [
              contact.id,
            ]),
          );
          return call('POST', `/email-verification/${action}`, {
            inBusiness: true,
            payload: {
              contactId: toPublicId('contact', contact.id),
              addressId: toPublicId('contact_identity', identity.id),
            },
          });
        },
      },
    ]),
  ),
  // Sites: each on records added directly for that try (test/sites-fixtures.ts).
  ...siteExamples(
    () => database,
    () => matrixBusiness,
  ),
  // Commerce: each on records added directly for that try (test/commerce-fixtures.ts).
  ...commerceExamples(
    () => database,
    () => matrixBusiness,
    () => matrixContact,
  ),
  'invoice_reminder.create': {
    run: (call) =>
      call('POST', '/invoice-reminders', {
        inBusiness: true,
        payload: {
          name: 'Reminder',
          everyAmount: 3,
          everyUnit: 'days',
          direction: 'after',
          anchor: 'due_date',
          maxSends: 3,
          subject: 'Invoice due',
          body: 'Hello {{ contact.name }}',
        },
      }),
  },
  'invoice_reminder.update': {
    run: async (call) => {
      const reminderId = randomUUID();
      const row = await database.as('crm_owner', (sql) =>
        sql.one<{ updated_at: Date }>(
          `insert into commerce.invoice_reminders
             (business_id, id, name, every_amount, every_unit, direction, anchor, max_sends, subject, body)
           values ($1, $2, 'Reminder', 3, 'days', 'after', 'due_date', 3, 'Due', 'Pay')
           returning updated_at`,
          [matrixBusiness, reminderId],
        ),
      );
      return call('PATCH', `/invoice-reminders/${reminderId}`, {
        inBusiness: true,
        payload: { name: 'Updated', updatedAt: row.updated_at.toISOString() },
      });
    },
  },
  'invoice_reminder.delete': {
    run: async (call) => {
      const reminderId = randomUUID();
      await database.as('crm_owner', (sql) =>
        sql.query(
          `insert into commerce.invoice_reminders
             (business_id, id, name, every_amount, every_unit, direction, anchor, max_sends, subject, body)
           values ($1, $2, 'Reminder', 3, 'days', 'after', 'due_date', 3, 'Due', 'Pay')`,
          [matrixBusiness, reminderId],
        ),
      );
      return call('DELETE', `/invoice-reminders/${reminderId}`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  // Media Storage: each on a folder and a library file added for that try.
  ...mediaExamples(
    () => database,
    () => matrixBusiness,
  ),
  // The App Marketplace: each on an app or an install added for that try.
  ...marketplaceExamples(
    () => database,
    () => matrixBusiness,
  ),
  // Saved reports: each on a report added directly for that try.
  ...reportingExamples(
    () => database,
    () => matrixBusiness,
  ),
  // Email campaigns: each on a campaign added directly for that try, with a mailbox and an
  // audience that pass its checks.
  ...campaignExamples(
    () => database,
    () => matrixBusiness,
  ),
  // The in-app assistant's conversations. Every built-in role may talk to it, the viewer
  // included: what it then reads or changes is held to the rest of the role.
  'assistant.start_turn': { run: (call) => startAssistantTurn(call) },
  'assistant.cancel_turn': {
    async run(call) {
      const started = await startAssistantTurn(call);
      if (started.statusCode >= 400) return started;
      const { turn } = assistantTurnStarted.parse(started.json());
      return call('POST', `/assistant/turns/${turn.id}/cancel`, {
        payload: {},
        inBusiness: true,
      });
    },
  },
  'assistant.delete_thread': {
    async run(call) {
      const started = await startAssistantTurn(call);
      if (started.statusCode >= 400) return started;
      const { thread, turn } = assistantTurnStarted.parse(started.json());
      // A thread is deleted once nothing runs in it: its one turn is stopped first.
      const stopped = await call('POST', `/assistant/turns/${turn.id}/cancel`, {
        payload: {},
        inBusiness: true,
      });
      if (stopped.statusCode >= 400) return stopped;
      return call('DELETE', `/assistant/threads/${thread.id}`, {
        payload: undefined,
        inBusiness: true,
      });
    },
  },
  // The assistant: asking for a draft of a reply, and how much it does on its own.
  'ai.request_reply_draft': {
    run: (call) =>
      call('POST', `/conversations/${matrixConversation}/assistant/draft`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'ai.set_autonomy': {
    run: (call, run) =>
      call('PUT', '/ai/autonomy', {
        inBusiness: true,
        payload: {
          agent: 'inbox',
          action: 'send_message',
          level: run % 2 === 0 ? 'ask' : 'suggest',
        },
      }),
  },
  // Settings → AI models. The routes run in the order they are served: the matrix
  // business's model server is changed, tested, then removed; a price is set, then removed.
  'ai.connect_provider': {
    run: (call) =>
      call('POST', '/ai/connections', {
        inBusiness: true,
        // Made up for this file: no provider issued it.
        payload: { provider: 'anthropic', apiKey: 'sk-ant-fixture-matrix-0000' },
      }),
  },
  'ai.update_connection': {
    run: (call, run) =>
      call('PATCH', `/ai/connections/${matrixAiConnection}`, {
        inBusiness: true,
        payload: { model: `matrix-model-${String(run)}` },
      }),
  },
  'ai.test_connection': {
    run: (call) =>
      call('POST', '/ai/connection-tests', {
        inBusiness: true,
        payload: { connectionId: matrixAiConnection },
      }),
  },
  'ai.remove_connection': {
    run: (call) =>
      call('DELETE', `/ai/connections/${matrixAiConnection}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'ai.update_settings': {
    run: async (call) => {
      // Whoever may not change the settings may not read them either, and is refused
      // before the revision is looked at.
      const current = await call('GET', '/ai/settings', { inBusiness: true, payload: undefined });
      const revision =
        current.statusCode === 200 ? aiSettings.parse(current.json()).revision : 'a'.repeat(64);
      return call('PUT', '/ai/settings', {
        inBusiness: true,
        payload: {
          enabled: true,
          keySource: 'own',
          monthlyLimit: '50',
          atLimit: 'pause',
          maskContactDetails: true,
          requestLogDays: 30,
          backup: null,
          jobs: { automation_builder: null, replies: null, briefings: null, sorting: null },
          revision,
        },
      });
    },
  },
  'ai.set_model_price': {
    run: (call) =>
      call('PUT', '/ai/model-prices', {
        inBusiness: false,
        payload: {
          provider: 'openai_compatible',
          model: 'matrix-model',
          inputPerMtok: '0',
          outputPerMtok: '0',
          source: 'Runs on our own server',
        },
      }),
  },
  'ai.remove_model_price': {
    run: (call) =>
      call('DELETE', '/ai/model-prices?provider=openai_compatible&model=matrix-model', {
        inBusiness: false,
        payload: undefined,
      }),
  },
  'template.create': {
    run: (call, run) =>
      call('POST', '/message-templates', {
        inBusiness: true,
        payload: {
          name: `Matrix template ${String(run)}`,
          subject: 'Hello {{contact.firstName}}',
          body: 'Hi {{contact.firstName}}',
        },
      }),
  },
  'template.update': {
    run: async (call, run) =>
      call('PUT', `/message-templates/${matrixTemplate}`, {
        inBusiness: true,
        payload: {
          name: 'Matrix guide',
          subject: `Run ${String(run)}`,
          body: 'Hi {{contact.firstName}}',
          revision: await matrixTemplateRevision(call),
        },
      }),
  },
  // Archived: a template of its own for each try, since the matrix automation sends the
  // matrix template and one a workflow sends can't be archived.
  'template.archive': {
    run: async (call, run) => {
      const created = await call('POST', '/message-templates', {
        inBusiness: true,
        payload: {
          name: `Matrix template to archive ${String(run)}`,
          subject: 'Hello',
          body: 'Hi there',
        },
      });
      if (created.statusCode >= 400) return created;
      const template = created.json<{ id: string; revision: string }>();
      return call('POST', `/message-templates/${template.id}/archive`, {
        inBusiness: true,
        payload: { revision: template.revision },
      });
    },
  },
  'template.restore': {
    run: async (call) =>
      call('POST', `/message-templates/${matrixTemplate}/restore`, {
        inBusiness: true,
        payload: { revision: await matrixTemplateRevision(call) },
      }),
  },
  'template.create_folder': {
    run: (call, run) =>
      call('POST', '/message-template-folders', {
        inBusiness: true,
        payload: { name: `Matrix template folder ${String(run)}` },
      }),
  },
  'template.update_folder': {
    run: async (call, run) => {
      const created = await examples['template.create_folder']?.run(call, run);
      if (created === undefined) throw new Error('Missing template folder example.');
      if (created.statusCode >= 400) return created;
      const folder = created.json<{ id: string; revision: number }>();
      return call('PATCH', `/message-template-folders/${folder.id}`, {
        inBusiness: true,
        payload: { revision: folder.revision, name: `Renamed template folder ${String(run)}` },
      });
    },
  },
  'template.remove_folder': {
    run: async (call, run) => {
      const created = await examples['template.create_folder']?.run(call, run);
      if (created === undefined) throw new Error('Missing template folder example.');
      if (created.statusCode >= 400) return created;
      const folder = created.json<{ id: string; revision: number }>();
      return call('DELETE', `/message-template-folders/${folder.id}`, {
        inBusiness: true,
        payload: { revision: folder.revision },
      });
    },
  },
  'template.move': {
    run: async (call) =>
      call('PUT', `/message-templates/${matrixTemplate}/folder`, {
        inBusiness: true,
        payload: { revision: await matrixTemplateRevision(call), folderId: null },
      }),
  },
  // Deleted: a template of its own for each try, so the matrix template stays live.
  'template.delete': {
    run: async (call, run) => {
      const created = await call('POST', '/message-templates', {
        inBusiness: true,
        payload: {
          name: `Matrix template to delete ${String(run)}`,
          subject: 'Hello',
          body: 'Hi there',
        },
      });
      if (created.statusCode >= 400) return created;
      const template = created.json<{ id: string; revision: string }>();
      return call('DELETE', `/message-templates/${template.id}`, {
        inBusiness: true,
        payload: { revision: template.revision },
      });
    },
  },
  'template.duplicate': {
    run: (call, run) =>
      call('POST', `/message-templates/${matrixTemplate}/duplicate`, {
        inBusiness: true,
        payload: { name: `Matrix template copy ${String(run)}` },
      }),
  },
  'template.bulk': {
    run: (call) =>
      call('POST', '/message-templates/bulk', {
        inBusiness: true,
        payload: { action: 'move', ids: [matrixTemplate], folderId: null },
      }),
  },
  // Snippets and their folders, trigger links, and the manual actions queue.
  'snippet.create': {
    run: (call, run) =>
      call('POST', '/snippets', {
        inBusiness: true,
        payload: { type: 'text', name: `Matrix snippet ${String(run)}`, body: 'Running late.' },
      }),
  },
  'snippet.update': {
    run: async (call, run) => {
      const created = await examples['snippet.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing snippet example.');
      if (created.statusCode >= 400) return created;
      const saved = snippet.parse(created.json());
      return call('PUT', `/snippets/${saved.id}`, {
        inBusiness: true,
        payload: {
          name: saved.name,
          subject: null,
          body: 'On our way.',
          folderId: null,
          revision: saved.revision,
        },
      });
    },
  },
  'snippet.move': {
    run: async (call, run) => {
      const folder = await examples['snippet_folder.create']?.run(call, run);
      const created = await examples['snippet.create']?.run(call, run);
      if (folder === undefined || created === undefined)
        throw new Error('Missing snippet examples.');
      if (folder.statusCode >= 400) return folder;
      if (created.statusCode >= 400) return created;
      return call('POST', '/snippets/move', {
        inBusiness: true,
        payload: {
          snippetIds: [snippet.parse(created.json()).id],
          folderId: snippetFolder.parse(folder.json()).id,
        },
      });
    },
  },
  'snippet.delete': {
    run: async (call, run) => {
      const created = await examples['snippet.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing snippet example.');
      if (created.statusCode >= 400) return created;
      const { id } = snippet.parse(created.json());
      return call('DELETE', `/snippets/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  // Whoever may reply need not be able to make a snippet, so this one is added directly.
  'snippet.render': {
    run: async (call) =>
      call('POST', `/snippets/${await matrixSnippet()}/render`, {
        inBusiness: true,
        payload: { contactId: matrixContact },
      }),
  },
  'snippet_folder.create': {
    run: (call, run) =>
      call('POST', '/snippet-folders', {
        inBusiness: true,
        payload: { name: `Matrix snippet folder ${String(run)}` },
      }),
  },
  'snippet_folder.rename': {
    run: async (call, run) => {
      const created = await examples['snippet_folder.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing snippet folder example.');
      if (created.statusCode >= 400) return created;
      const folder = snippetFolder.parse(created.json());
      return call('PUT', `/snippet-folders/${folder.id}`, {
        inBusiness: true,
        payload: { name: `Renamed snippet folder ${String(run)}`, revision: folder.revision },
      });
    },
  },
  'snippet_folder.delete': {
    run: async (call, run) => {
      const created = await examples['snippet_folder.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing snippet folder example.');
      if (created.statusCode >= 400) return created;
      const { id } = snippetFolder.parse(created.json());
      return call('DELETE', `/snippet-folders/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  'trigger_link.create': {
    run: (call, run) =>
      call('POST', '/trigger-links', {
        inBusiness: true,
        payload: { name: `Matrix link ${String(run)}`, url: 'https://harborlights.example/offer' },
      }),
  },
  'trigger_link.update': {
    run: async (call, run) => {
      const created = await examples['trigger_link.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing trigger link example.');
      if (created.statusCode >= 400) return created;
      const link = triggerLink.parse(created.json());
      return call('PUT', `/trigger-links/${link.id}`, {
        inBusiness: true,
        payload: {
          name: link.name,
          url: 'https://harborlights.example/new',
          revision: link.revision,
        },
      });
    },
  },
  'trigger_link.delete': {
    run: async (call, run) => {
      const created = await examples['trigger_link.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing trigger link example.');
      if (created.statusCode >= 400) return created;
      const { id } = triggerLink.parse(created.json());
      return call('DELETE', `/trigger-links/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  // Each closes or assigns a pending action of its own, added directly: no route makes one.
  'manual_action.assign': {
    run: async (call) => {
      const action = await matrixManualAction();
      return call('PUT', `/manual-actions/${action.id}/assignee`, {
        inBusiness: true,
        payload: { assignee: null, revision: action.revision },
      });
    },
  },
  'manual_action.complete': {
    run: async (call) => {
      const action = await matrixManualAction();
      return call('POST', `/manual-actions/${action.id}/complete`, {
        inBusiness: true,
        payload: { revision: action.revision },
      });
    },
  },
  'manual_action.skip': {
    run: async (call) => {
      const action = await matrixManualAction();
      return call('POST', `/manual-actions/${action.id}/skip`, {
        inBusiness: true,
        payload: { revision: action.revision },
      });
    },
  },
  'conversation.assign': {
    run: async (call) =>
      call('PUT', `/conversations/${matrixConversation}/assignee`, {
        inBusiness: true,
        payload: { assignee: null, revision: await matrixConversationRevision(call) },
      }),
  },
  'conversation.set_status': {
    run: async (call) =>
      call('PUT', `/conversations/${matrixConversation}/status`, {
        inBusiness: true,
        payload: { status: 'closed', revision: await matrixConversationRevision(call) },
      }),
  },
  'conversation.mark_read': {
    run: (call) =>
      call('POST', `/conversations/${matrixConversation}/read`, {
        inBusiness: true,
        payload: { through: matrixMessage },
      }),
  },
  // Starred once, and already starred for every role after: the command still runs.
  'conversation.bulk': {
    run: (call) =>
      call('POST', '/conversations/bulk', {
        inBusiness: true,
        payload: { action: 'star', ids: [matrixConversation] },
      }),
  },
  'conversation.add_note': {
    run: (call, run) =>
      call('POST', `/conversations/${matrixConversation}/notes`, {
        inBusiness: true,
        payload: { text: 'Call Maya back.', idempotencyKey: `matrix-note-key-${String(run)}` },
      }),
  },
  // No consent is recorded for the fixture's contact, so the pipeline stores the reply as
  // refused: the command itself ran, which is all the matrix asks.
  'conversation.reply': {
    run: (call, run) =>
      call('POST', `/conversations/${matrixConversation}/replies`, {
        inBusiness: true,
        payload: {
          channel: 'email',
          accountId: matrixSendingAccount,
          to: matrixIdentity,
          text: 'Hi Maya',
          idempotencyKey: `matrix-reply-key-${String(run)}`,
        },
      }),
  },
  'automation.create': {
    run: (call, run) =>
      call('POST', '/automations', {
        inBusiness: true,
        payload: { document: { ...matrixDocument, name: `Matrix ${String(run)}` } },
      }),
  },
  'automation.replace_draft': {
    run: async (call, run) => {
      const current = await matrixAutomationFor(call);
      return call('PUT', `/automations/${current.id}/draft`, {
        inBusiness: true,
        payload: {
          baseDraftVersion: current.draftVersion,
          document: { ...matrixDocument, description: `Run ${String(run)}` },
        },
      });
    },
  },
  'automation.patch_draft': {
    run: async (call, run) => {
      const current = await matrixAutomationFor(call);
      return call('PATCH', `/automations/${current.id}/draft`, {
        inBusiness: true,
        payload: {
          baseDraftVersion: current.draftVersion,
          patch: [{ op: 'add', path: '/description', value: `Run ${String(run)}` }],
        },
      });
    },
  },
  'automation.copy_email_template': {
    run: async (call) => {
      const current = await matrixAutomationFor(call);
      return call('POST', `/automations/${current.id}/draft/email-template-copy`, {
        inBusiness: true,
        payload: {
          baseDraftVersion: current.draftVersion,
          step: 'email',
          template: matrixTemplate,
          revision: await matrixTemplateRevision(call),
          document: {
            ...matrixDocument,
            steps: {
              ...matrixDocument.steps,
              pause: { ...matrixDocument.steps.pause, next: 'email' },
              email: { type: 'email.send', config: { template: matrixTemplate } },
            },
          },
        },
      });
    },
  },
  // "Sync edits to template". Turning it on changes the draft alone.
  'automation.enable_email_sync': {
    run: async (call) => {
      const current = await matrixAutomationFor(call);
      return call('POST', `/automations/${current.id}/draft/email-sync`, {
        inBusiness: true,
        payload: {
          baseDraftVersion: current.draftVersion,
          step: 'email',
          template: matrixTemplate,
          revision: await matrixTemplateRevision(call),
          document: {
            ...matrixDocument,
            steps: {
              ...matrixDocument.steps,
              pause: { ...matrixDocument.steps.pause, next: 'email' },
              email: { type: 'email.send', config: { template: matrixTemplate } },
            },
          },
        },
      });
    },
  },
  // An edit made through a syncing step is an edit of the template: it takes
  // templates.manage too, which every role that has automations.manage has.
  'automation.save_synced_email': {
    run: async (call, run) => {
      const current = await matrixAutomationFor(call);
      const revision = await matrixTemplateRevision(call);
      return call('PUT', `/automations/${current.id}/draft/email-sync/content`, {
        inBusiness: true,
        payload: {
          baseDraftVersion: current.draftVersion,
          step: 'email',
          revision,
          subject: `Synced ${String(run)}`,
          content: { format: 'html', html: `<p>Synced ${String(run)}</p>` },
          document: {
            ...matrixDocument,
            steps: {
              ...matrixDocument.steps,
              pause: { ...matrixDocument.steps.pause, next: 'email' },
              email: {
                type: 'email.send',
                config: { mode: 'sync', source: { id: matrixTemplate, revision } },
              },
            },
          },
        },
      });
    },
  },
  'automation.test': {
    run: (call) =>
      call('POST', `/automations/${matrixAutomation}/test-runs`, { inBusiness: true, payload: {} }),
  },
  // Runs a failed run of its own again, added directly: no route makes a run fail.
  'automation.retry_run': {
    run: async (call) =>
      call('POST', `/automation-runs/${await matrixFailedRun()}/retry`, {
        inBusiness: true,
        payload: {},
      }),
  },
  // Ends the wait of a waiting run of its own, added directly: each try needs a run that
  // still waits.
  'automation.continue_run': {
    run: async (call) =>
      call('POST', `/automation-runs/${await matrixWaitingRun()}/continue`, {
        inBusiness: true,
        payload: {},
      }),
  },
  'automation.publish': {
    run: async (call, run) => {
      const current = await matrixAutomationFor(call);
      return call('POST', `/automations/${current.id}/publish`, {
        inBusiness: true,
        payload: { baseDraftVersion: current.draftVersion, changeSummary: `Run ${String(run)}` },
      });
    },
  },
  // Pausing and resuming need a live automation, and publishing needs the same permission:
  // whoever is refused it is refused here first, naming it.
  'automation.pause': {
    run: async (call, run) => {
      const published = await examples['automation.publish']?.run(call, run);
      if (published === undefined) throw new Error('Missing publish example.');
      if (published.statusCode >= 400) return published;
      return call('POST', `/automations/${matrixAutomation}/pause`, {
        inBusiness: true,
        payload: {},
      });
    },
  },
  'automation.resume': {
    run: async (call, run) => {
      const paused = await examples['automation.pause']?.run(call, run);
      if (paused === undefined) throw new Error('Missing pause example.');
      if (paused.statusCode >= 400) return paused;
      return call('POST', `/automations/${matrixAutomation}/resume`, {
        inBusiness: true,
        payload: {},
      });
    },
  },
  'automation.rotate_webhook_secret': {
    run: (call) =>
      call('POST', '/automations/webhook-signing/rotate', { inBusiness: true, payload: {} }),
  },
  // A secret of its own for each run, so a role's later delete has one to remove.
  'automation.put_webhook_secret': {
    run: (call, run) =>
      call('PUT', `/automations/webhook-secrets/matrix_key_${String(run)}`, {
        inBusiness: true,
        payload: { value: `matrix-value-${String(run)}` },
      }),
  },
  // Deleting needs a secret, and storing one needs the same permission: whoever is refused
  // it is refused here first, naming it.
  'automation.delete_webhook_secret': {
    run: async (call, run) => {
      const stored = await examples['automation.put_webhook_secret']?.run(call, run);
      if (stored === undefined) throw new Error('Missing webhook secret example.');
      if (stored.statusCode >= 400) return stored;
      return call('DELETE', `/automations/webhook-secrets/matrix_key_${String(run)}`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  // Folders for automations, and the Deleted list. Each is tried on a folder or an
  // automation made for it directly, so a role that may not make one is still asked.
  'automation.create_folder': {
    run: (call, run) =>
      call('POST', '/automation-folders', {
        inBusiness: true,
        payload: { name: `Matrix folder ${String(run)}` },
      }),
  },
  'automation.update_folder': {
    run: async (call, run) =>
      call('PATCH', `/automation-folders/${await matrixAutomationFolder()}`, {
        inBusiness: true,
        payload: { revision: 1, name: `Renamed ${String(run)}` },
      }),
  },
  'automation.delete_folder': {
    run: async (call) =>
      call('DELETE', `/automation-folders/${await matrixAutomationFolder()}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'automation.move': {
    run: (call) =>
      call('PUT', `/automations/${matrixAutomation}/folder`, {
        inBusiness: true,
        payload: { folderId: null },
      }),
  },
  'automation.delete': {
    run: async (call) =>
      call('DELETE', `/automations/${await matrixSpareAutomation(false)}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'automation.restore': {
    run: async (call) =>
      call('POST', `/automations/${await matrixSpareAutomation(true)}/restore`, {
        inBusiness: true,
        payload: {},
      }),
  },
  'calendar.create': {
    run: (call, run) =>
      call('POST', '/calendars', {
        inBusiness: true,
        payload: {
          name: `Matrix ${String(run)}`,
          kind: 'personal',
          timezone: 'UTC',
          bookingSlug: `matrix-${String(run)}`,
          members: [],
          weeklyHours: [],
          dateOverrides: [],
        },
      }),
  },
  'calendar.update': {
    run: async (call, run) => {
      const { calendar, revision } = await matrixCalendarFor(call);
      return call('PUT', `/calendars/${calendar.id}`, {
        inBusiness: true,
        payload: {
          name: calendar.name,
          description: `Run ${String(run)}`,
          kind: 'personal',
          timezone: calendar.timezone,
          bookingSlug: calendar.bookingSlug,
          isActive: false,
          revision,
        },
      });
    },
  },
  'calendar.availability.update': {
    run: async (call) => {
      const { revision } = await matrixCalendarFor(call);
      return call('PUT', `/calendars/${matrixCalendar}/availability`, {
        inBusiness: true,
        payload: {
          members: [],
          weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
          dateOverrides: [],
          revision,
        },
      });
    },
  },
  // A calendar nobody was booked on is deleted; groups are made, renamed and deleted.
  'calendar.delete': {
    run: async (call, run) => {
      const made = await call('POST', '/calendars', {
        inBusiness: true,
        payload: {
          name: `Spare ${String(run)}`,
          kind: 'personal',
          timezone: 'UTC',
          bookingSlug: `spare-${String(run)}-${randomUUID().slice(0, 8)}`,
          members: [],
          weeklyHours: [],
          dateOverrides: [],
        },
      });
      // Someone who may not make a calendar is refused the deletion of the matrix's own.
      const id =
        made.statusCode === 201
          ? calendarConfiguration.parse(made.json()).calendar.id
          : matrixCalendar;
      return call('DELETE', `/calendars/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  'calendar_group.create': {
    run: (call, run) =>
      call('POST', '/calendar-groups', {
        inBusiness: true,
        payload: { name: `Matrix group ${String(run)} ${randomUUID().slice(0, 8)}` },
      }),
  },
  'calendar_group.rename': {
    run: async (call, run) =>
      call('PUT', `/calendar-groups/${await matrixCalendarGroup()}`, {
        inBusiness: true,
        payload: { name: `Renamed ${String(run)} ${randomUUID().slice(0, 8)}` },
      }),
  },
  'calendar_group.delete': {
    run: async (call) =>
      call('DELETE', `/calendar-groups/${await matrixCalendarGroup()}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  // Blocked slots: blocking someone's time is configuring the team's availability.
  'calendar.blocked_slot.create': {
    run: async (call) =>
      call('POST', '/calendars/blocked-slots', {
        inBusiness: true,
        payload: {
          membershipId: await matrixScheduleMember(),
          title: 'Leave',
          startsAt: '2026-11-02T06:00:00Z',
          endsAt: '2026-11-06T15:00:00Z',
        },
      }),
  },
  'calendar.blocked_slot.update': {
    run: async (call) => {
      const { id, membershipId, revision } = await matrixBlockedSlotFor(call);
      return call('PUT', `/calendars/blocked-slots/${id}`, {
        inBusiness: true,
        payload: {
          membershipId,
          title: 'Leave, moved',
          startsAt: '2026-11-09T06:00:00Z',
          endsAt: '2026-11-13T15:00:00Z',
          revision,
        },
      });
    },
  },
  'calendar.blocked_slot.delete': {
    run: async (call) =>
      call('DELETE', `/calendars/blocked-slots/${(await matrixBlockedSlotFor(call)).id}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'calendar.appointment.book': {
    run: async (call) => {
      const { calendar } = await matrixBookings();
      return call('POST', '/appointments', {
        inBusiness: true,
        payload: {
          requestId: randomUUID(),
          calendarId: calendar,
          contactId: matrixContact,
          ...matrixSlot(),
          ignoreAvailability: true,
        },
      });
    },
  },
  'calendar.appointment.reschedule': {
    run: async (call) => {
      const { id, revision } = await matrixAppointmentFor(call);
      return call('POST', `/appointments/${id}/reschedule`, {
        inBusiness: true,
        payload: { revision, ...matrixSlot(), ignoreAvailability: true },
      });
    },
  },
  'calendar.appointment.cancel': {
    run: async (call) => {
      const { id, revision } = await matrixAppointmentFor(call);
      return call('POST', `/appointments/${id}/cancel`, {
        inBusiness: true,
        payload: { revision, reason: 'Asked to come another week.' },
      });
    },
  },
  'calendar.appointment.set_status': {
    run: async (call) => {
      const { id, revision } = await matrixAppointmentFor(call);
      return call('PUT', `/appointments/${id}/status`, {
        inBusiness: true,
        payload: { revision, status: 'no_show' },
      });
    },
  },
  'calendar.appointment.set_notes': {
    run: async (call) => {
      const { id, revision } = await matrixAppointmentFor(call);
      return call('PUT', `/appointments/${id}/notes`, {
        inBusiness: true,
        payload: { revision, notes: 'Bring the floor plans.' },
      });
    },
  },
  // Google Calendar: each person's own connection. Connecting only makes Google's consent
  // address; the others change the person's connection, made for them here.
  'calendar.google.connect': {
    run: (call) =>
      call('POST', '/integrations/google/connect', { inBusiness: true, payload: undefined }),
  },
  'calendar.google.choose_calendars': {
    run: async (call) => {
      await matrixGoogleConnection();
      return call('PUT', '/integrations/google/calendars', {
        inBusiness: true,
        payload: { linkedCalendarId: null, conflictCalendarIds: [] },
      });
    },
  },
  'calendar.google.refresh': {
    run: async (call) => {
      await matrixGoogleConnection();
      return call('POST', '/integrations/google/refresh', { inBusiness: true, payload: undefined });
    },
  },
  'calendar.google.disconnect': {
    run: async (call) => {
      await matrixGoogleConnection();
      return call('DELETE', '/integrations/google', { inBusiness: true, payload: undefined });
    },
  },
  'calendar.user_availability.update': {
    run: async (call) =>
      call('PUT', `/calendars/users/${await matrixScheduleMember()}/availability`, {
        inBusiness: true,
        payload: {
          // The revision of having no schedule stored: reading one needs the permission too.
          revision: createHash('sha256').update(JSON.stringify(null)).digest('hex'),
          profile: {
            timezone: 'Africa/Nairobi',
            inheritCalendarHours: false,
            weeklyHours: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
            dateOverrides: [{ date: '2026-12-25', ranges: [] }],
          },
        },
      }),
  },
  'consents.record': {
    run: (call) =>
      call('POST', `/contacts/${matrixContact}/consent`, {
        inBusiness: true,
        payload: {
          channel: 'email',
          purpose: 'marketing',
          status: 'granted',
          note: 'Asked by phone on 9 October.',
        },
      }),
  },
  'messaging.update_settings': {
    run: async (call) => {
      const current = await call('GET', '/messaging-settings', {
        inBusiness: true,
        payload: undefined,
      });
      const { revision, contactDailyLimit } = messagingSettings.parse(current.json());
      return call('PUT', '/messaging-settings', {
        inBusiness: true,
        payload: {
          quietHoursEnabled: true,
          quietHoursStart: '21:00',
          quietHoursEnd: '08:00',
          contactDailyLimit,
          revision,
        },
      });
    },
  },
  'sms.connect': {
    run: (call, run) =>
      call('POST', '/sms-connection-attempts', {
        inBusiness: true,
        payload: {
          provider: 'twilio',
          label: 'Permission fixture',
          accountSid: `AC${String(run).padStart(32, '0')}`,
          authToken: 'fixture-only',
        },
      }),
  },
  'sms.refresh_numbers': {
    run: (call) =>
      call('POST', `/sms-connections/${matrixSmsConnection}/number-refreshes`, {
        inBusiness: true,
        payload: {},
      }),
  },
  // Queues setting up calling on the matrix's Twilio account; no worker runs here, so every
  // allowed role after the first is answered with the setup already under way.
  'phone.set_up_calling': {
    run: (call) =>
      call('POST', `/sms-connections/${matrixSmsConnection}/calling-setup`, {
        inBusiness: true,
        payload: {},
      }),
  },
  'sms.register_number': {
    run: (call) =>
      call('POST', '/phone-numbers', {
        inBusiness: true,
        payload: {
          connectionId: matrixSmsConnection,
          providerNumberRef: matrixSmsNumber,
          name: 'Matrix number',
        },
      }),
  },
  // A role without phone.manage can't read the revision either: the save is then made on
  // a stale one, and refused for the permission before the revision is looked at.
  'phone.update_settings': {
    run: async (call) => {
      const current = await call('GET', '/phone-system/settings', {
        inBusiness: true,
        payload: undefined,
      });
      const revision =
        current.statusCode === 200
          ? phoneSystemSettings.parse(current.json()).revision
          : '0'.repeat(64);
      return call('PUT', '/phone-system/settings', {
        inBusiness: true,
        payload: {
          defaultNumberId: matrixPhoneNumber,
          inbound: { preferAssignedUser: true, allowAnonymousCallers: true, fallbackNumber: null },
          outbound: {
            callerId: 'account_default',
            connectAgent: 'after_announcement',
            quietHoursWarning: true,
          },
          recording: { retentionDays: null, transcriptionEnabled: false },
          missedCallText: { enabled: false, message: null },
          revision,
        },
      });
    },
  },
  'phone_number.update_settings': {
    run: async (call, run) => {
      const current = await call('GET', `/phone-numbers/${matrixPhoneNumber}/settings`, {
        inBusiness: true,
        payload: undefined,
      });
      const read =
        current.statusCode === 200 ? phoneNumberSettings.parse(current.json()) : undefined;
      return call('PUT', `/phone-numbers/${matrixPhoneNumber}/settings`, {
        inBusiness: true,
        payload: {
          name: `Matrix line ${String(run)}`,
          ownerId: null,
          voice: {
            recording: { enabled: false, announcement: { enabled: false, message: null } },
            routing: {
              primaryMemberId: null,
              forwardTo: null,
              useBusinessFallback: false,
              ringAlso: [],
              ringTimeoutSeconds: 20,
              voicemailBackup: true,
            },
            advanced: {
              callConnectConfirmation: false,
              whisper: { enabled: false, message: null },
              forwardedCallerId: 'caller',
              preferContactOwner: false,
            },
          },
          revision: read?.revision ?? '0'.repeat(64),
        },
      });
    },
  },
  'webchat.create_widget': {
    run: (call, run) =>
      call('POST', '/webchat/widgets', {
        inBusiness: true,
        payload: { ...matrixWidgetInput, name: `Matrix widget ${String(run)}` },
      }),
  },
  'webchat.update_widget': {
    run: (call) =>
      call('PUT', `/webchat/widgets/${matrixWidget}`, {
        inBusiness: true,
        payload: { ...matrixWidgetInput, enabled: false },
      }),
  },
  // Calling a contact is daily work: calls.place. Each try is its own press.
  'call.request': {
    run: (call, run) =>
      call('POST', '/calls', {
        inBusiness: true,
        payload: {
          contactIdentityId: matrixPhoneIdentity,
          phoneNumberId: matrixPhoneNumber,
          idempotencyKey: `matrix-call-${String(run).padStart(8, '0')}`,
        },
      }),
  },
  // A browser calling token is daily work too: calls.place, for a person signed in.
  'calls.request_voice_grant': {
    run: (call) => call('POST', '/voice-grants', { inBusiness: true, payload: undefined }),
  },
  // A person hangs up the call they asked for; whoever may not ask for one is refused the
  // hang-up of a call that isn't there, for the same permission.
  'call.hang_up': {
    run: async (call, run) => {
      const made = await call('POST', '/calls', {
        inBusiness: true,
        payload: {
          contactIdentityId: matrixPhoneIdentity,
          phoneNumberId: matrixPhoneNumber,
          idempotencyKey: `matrix-hang-up-${String(run).padStart(8, '0')}`,
        },
      });
      const id =
        made.statusCode === 201
          ? callRecord.parse(made.json()).id
          : toPublicId('call', '01890a5d-ac96-774b-bcce-b302099a8057');
      return call('POST', `/calls/${id}/hang-up`, { inBusiness: true, payload: undefined });
    },
  },
  'webchat.rotate_widget_key': {
    run: (call) =>
      call('POST', `/webchat/widgets/${matrixWidget}/rotate-key`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  // The business's own lead source rules. Each example leaves at most one rule behind, far
  // under the fifty a business may have.
  'forms.lead_source_rule.create': {
    run: (call, run) =>
      call('POST', '/lead-sources/rules', {
        inBusiness: true,
        payload: {
          name: `Matrix rule ${String(run)}`,
          conditions: [{ fact: 'utm_campaign', op: 'contains', value: 'spring' }],
          source: 'Spring promo',
        },
      }),
  },
  'forms.lead_source_rule.update': {
    run: async (call, run) => {
      const created = await examples['forms.lead_source_rule.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing lead source rule example.');
      if (created.statusCode >= 400) return created;
      const rule = leadSourceRule.parse(created.json());
      return call('PUT', `/lead-sources/rules/${rule.id}`, {
        inBusiness: true,
        payload: {
          name: rule.name,
          enabled: false,
          conditions: rule.conditions,
          source: 'Spring promo',
          tagIds: [],
          fieldWrites: [],
          revision: rule.revision,
        },
      });
    },
  },
  'forms.lead_source_rule.delete': {
    run: async (call, run) => {
      const created = await examples['forms.lead_source_rule.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing lead source rule example.');
      if (created.statusCode >= 400) return created;
      const { id } = leadSourceRule.parse(created.json());
      return call('DELETE', `/lead-sources/rules/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  'forms.lead_source_rule.reorder': {
    run: async (call, run) => {
      // Whoever may order the rules may add one, so there is one to order. Whoever may not
      // is still asked to order them, below: it is that refusal this row is about.
      await examples['forms.lead_source_rule.create']?.run(call, run);
      // Anyone in the business reads the rules.
      const read = await call('GET', '/lead-sources/rules', {
        inBusiness: true,
        payload: undefined,
      });
      if (read.statusCode >= 400) return read;
      const list = leadSourceRuleList.parse(read.json());
      const ruleIds = list.items.map((rule) => rule.id).reverse();
      return call('POST', '/lead-sources/rules/order', {
        inBusiness: true,
        payload: {
          // With no rule to name, a well-formed id of none: the body is read only after the
          // permission is.
          ruleIds: ruleIds.length === 0 ? ['lsr_01h455vb4pex5vsknk084sn02q'] : ruleIds,
          revision: list.revision,
        },
      });
    },
  },
  'forms.create': {
    run: (call, run) =>
      call('POST', '/forms', {
        inBusiness: true,
        payload: { name: `Matrix form ${String(run)}` },
      }),
  },
  'forms.update': {
    run: async (call, run) => {
      const current = await matrixFormFor(call);
      return call('PUT', `/forms/${matrixForm}`, {
        inBusiness: true,
        payload: {
          name: `Matrix form, saved ${String(run)}`,
          definition: current.definition,
          allowedOrigins: current.allowedOrigins,
          revision: current.revision,
        },
      });
    },
  },
  // The routes run in the order they are served: published here, taken down by the next,
  // then archived and restored.
  'forms.publish': {
    run: async (call) =>
      call('POST', `/forms/${matrixForm}/publish`, {
        inBusiness: true,
        payload: { revision: (await matrixFormFor(call)).revision },
      }),
  },
  'forms.unpublish': {
    run: async (call) =>
      call('POST', `/forms/${matrixForm}/unpublish`, {
        inBusiness: true,
        payload: { revision: (await matrixFormFor(call)).revision },
      }),
  },
  'forms.archive': {
    run: async (call) =>
      call('POST', `/forms/${matrixForm}/archive`, {
        inBusiness: true,
        payload: { revision: (await matrixFormFor(call)).revision },
      }),
  },
  'forms.restore': {
    run: async (call) =>
      call('POST', `/forms/${matrixForm}/restore`, {
        inBusiness: true,
        payload: { revision: (await matrixFormFor(call)).revision },
      }),
  },
  'forms.discard_submission': {
    run: async (call) =>
      call('DELETE', `/forms/${matrixForm}/submissions/${await matrixUnattachedSubmission()}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'mailboxes.update_sending': {
    run: (call) =>
      call('PUT', `/mailboxes/${matrixMailbox}/sending`, {
        inBusiness: true,
        payload: {
          dailyLimit: 80,
          pacingPerMinute: 3,
          warmupEnabled: true,
          useForConversations: true,
          useForCampaigns: false,
        },
      }),
  },
  'mailboxes.check': {
    run: (call) =>
      call('POST', `/mailboxes/${matrixMailbox}/checks`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'mailboxes.connect': {
    run: (call, run) =>
      call('POST', '/mailbox-connection-attempts', {
        inBusiness: true,
        payload: {
          name: 'Permission fixture',
          email: `mail-${String(run)}@example.test`,
          smtp: {
            host: 'mail.example.test',
            port: 465,
            security: 'tls',
            username: 'fixture',
            password: 'fixture-only',
          },
          imap: {
            host: 'mail.example.test',
            port: 993,
            security: 'tls',
            username: 'fixture',
            password: 'fixture-only',
          },
        },
      }),
  },
  'task.create': {
    run: (call) =>
      call('POST', '/tasks', {
        inBusiness: true,
        payload: { title: 'Call Maya', recordId: matrixContact, assignee: 'me' },
      }),
  },
  'task.update': {
    run: async (call) => {
      const current = await matrixTaskFor(call);
      return call('PUT', `/tasks/${current.id}`, {
        inBusiness: true,
        payload: {
          title: 'Confirm venue',
          description: current.description,
          dueAt: current.dueAt,
          assignee: null,
          revision: current.revision,
        },
      });
    },
  },
  'task.complete': {
    run: async (call) => {
      const current = await matrixTaskFor(call);
      const response = await call('POST', `/tasks/${current.id}/completion`, {
        inBusiness: true,
        payload: { completed: true, revision: current.revision },
      });
      if (response.statusCode === 200)
        expect(task.parse(response.json()).completedBy).toEqual({
          kind: 'user',
          name: 'Dana Brooks',
          you: true,
        });
      return response;
    },
  },
  'task.delete': {
    run: async (call) => {
      const current = await matrixTaskFor(call);
      return call('DELETE', `/tasks/${current.id}`, {
        inBusiness: true,
        payload: { revision: current.revision },
      });
    },
  },
  // Clearing a due date leaves who completed the task, which task.complete's example reads.
  'task.bulk': {
    run: (call) =>
      call('POST', '/tasks/bulk', {
        inBusiness: true,
        payload: { action: 'set_due', ids: [matrixTask], dueAt: null },
      }),
  },
  // Each view command acts on the caller's own view, so the role alone decides.
  'view.create': {
    run: (call, run) =>
      call('POST', '/views', {
        inBusiness: true,
        payload: {
          objectKey: 'contact',
          name: `Matrix view ${String(run)}`,
          state: {},
          columns: ['name'],
        },
      }),
  },
  'view.update': {
    run: async (call, run) => {
      const current = await matrixViewFor(call, 'private');
      return call('PUT', `/views/${current.id}`, {
        inBusiness: true,
        payload: {
          name: `Matrix view ${String(run)}`,
          state: { sort: 'name' },
          columns: ['name', 'email'],
          revision: current.revision,
        },
      });
    },
  },
  'view.delete': {
    run: async (call) => {
      const current = await matrixViewFor(call, 'private');
      return call('DELETE', `/views/${current.id}`, {
        inBusiness: true,
        payload: { revision: current.revision },
      });
    },
  },
  'view.share': {
    run: async (call) => {
      const current = await matrixViewFor(call, 'private');
      return call('POST', `/views/${current.id}/share`, {
        inBusiness: true,
        payload: { revision: current.revision },
      });
    },
  },
  'view.unshare': {
    run: async (call) => {
      const current = await matrixViewFor(call, 'shared');
      return call('POST', `/views/${current.id}/unshare`, {
        inBusiness: true,
        payload: { revision: current.revision },
      });
    },
  },
  // Sharing & permissions: the caller's own view, shared with everyone to view.
  'view.set_sharing': {
    run: async (call) => {
      const current = await matrixViewFor(call, 'private');
      return call('PUT', `/views/${current.id}/sharing`, {
        inBusiness: true,
        payload: { everyone: 'view', people: [], revision: current.revision },
      });
    },
  },
  'note.update': {
    run: async (call) => {
      const current = await matrixNoteFor(call);
      return call('PUT', `/records/${matrixContact}/notes/${current.id}`, {
        inBusiness: true,
        payload: {
          revision: current.revision,
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Venue confirmed.' }] }],
          },
        },
      });
    },
  },
  'note.delete': {
    run: async (call) => {
      const current = await matrixNoteFor(call);
      return call('DELETE', `/records/${matrixContact}/notes/${current.id}`, {
        inBusiness: true,
        payload: { revision: current.revision },
      });
    },
  },
  'note.create': {
    run: async (call) => {
      const saved = await call('POST', `/records/${matrixContact}/notes`, {
        inBusiness: true,
        payload: {
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Call Maya.' }] }],
          },
        },
      });
      if (saved.statusCode === 201)
        expect(note.parse(saved.json()).author).toEqual({
          kind: 'user',
          name: 'Dana Brooks',
          you: true,
        });
      return saved;
    },
  },
  'field.value.set': {
    run: async (call) => {
      const before = await call('GET', `/records/${matrixContact}/fields`, {
        inBusiness: true,
        payload: undefined,
      });
      const value = recordFields
        .parse(before.json())
        .items.find((item) => item.definition.id === matrixField);
      if (value === undefined) throw new Error('Missing matrix field.');
      const saved = await call('PUT', `/records/${matrixContact}/fields/${matrixField}`, {
        inBusiness: true,
        payload: { value: 'Updated', revision: value.revision },
      });
      if (saved.statusCode === 200) {
        const named = await call('GET', `/records/${matrixContact}/fields`, {
          inBusiness: true,
          payload: undefined,
        });
        expect(
          recordFields.parse(named.json()).items.find((item) => item.definition.id === matrixField)
            ?.source,
        ).toMatchObject({ name: 'Dana Brooks', you: true });
      }
      return saved;
    },
  },
  'field.value.confirm': {
    run: async (call) => {
      const before = await call('GET', `/records/${matrixContact}/fields`, {
        inBusiness: true,
        payload: undefined,
      });
      const value = recordFields
        .parse(before.json())
        .items.find((item) => item.definition.id === matrixAiField);
      if (value === undefined) throw new Error('Missing matrix field.');
      return call('POST', `/records/${matrixContact}/fields/${matrixAiField}/confirm`, {
        inBusiness: true,
        payload: { revision: value.revision },
      });
    },
  },
  'company.create': {
    run: (call, run) =>
      call('POST', '/companies', { inBusiness: true, payload: { name: `Company ${String(run)}` } }),
  },
  'company.update': {
    run: (call) =>
      call('PATCH', `/companies/${matrixCompany}`, {
        inBusiness: true,
        payload: { name: 'Updated company' },
      }),
  },
  'company.trash': {
    run: (call) =>
      call('DELETE', `/companies/${matrixCompany}`, { inBusiness: true, payload: undefined }),
  },
  'company.restore': {
    run: (call) =>
      call('POST', `/companies/${matrixCompany}/restore`, { inBusiness: true, payload: {} }),
  },
  // Settings → Objects. Each run makes its own object or association, keyed by the run, so
  // the ten a business may have are never all used: an object deleted no longer counts.
  'object.create': {
    run: (call, run) =>
      call('POST', '/objects', {
        inBusiness: true,
        payload: {
          singularLabel: `Matrix ${String(run)}`,
          pluralLabel: `Matrix ${String(run)}s`,
          primaryField: { label: 'Name', valueType: 'text' },
        },
      }),
  },
  'object.update': {
    run: async (call, run) => {
      const created = await examples['object.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing object example.');
      if (created.statusCode >= 400) return created;
      const made = objectDefinition.parse(created.json());
      return call('PATCH', `/objects/${made.key}`, {
        inBusiness: true,
        payload: {
          revision: made.revision,
          singularLabel: made.singularLabel,
          pluralLabel: made.pluralLabel,
          description: 'Changed in the matrix.',
          icon: 'star',
          searchableFieldIds: [],
        },
      });
    },
  },
  'object.delete': {
    run: async (call, run) => {
      const created = await examples['object.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing object example.');
      if (created.statusCode >= 400) return created;
      const made = objectDefinition.parse(created.json());
      return call('DELETE', `/objects/${made.key}`, {
        inBusiness: true,
        payload: { confirm: made.pluralLabel },
      });
    },
  },
  'association.create': {
    run: (call, run) =>
      call('POST', '/associations', {
        inBusiness: true,
        payload: {
          fromObjectKey: 'company',
          toObjectKey: 'deal',
          label: `Matrix ${String(run)}`,
          fromLimit: 1000,
          toLimit: 1000,
        },
      }),
  },
  'association.update': {
    run: async (call, run) => {
      const created = await call('POST', '/associations', {
        inBusiness: true,
        payload: {
          fromObjectKey: 'company',
          toObjectKey: 'company',
          label: `Matrix ${String(run)}`,
          fromLimit: 1000,
          toLimit: 1000,
        },
      });
      if (created.statusCode >= 400) return created;
      return call('PATCH', `/associations/${associationContract.parse(created.json()).id}`, {
        inBusiness: true,
        payload: { label: `Parent ${String(run)}`, reverseLabel: `Branch ${String(run)}` },
      });
    },
  },
  'association.delete': {
    run: async (call, run) => {
      const created = await call('POST', '/associations', {
        inBusiness: true,
        payload: {
          fromObjectKey: 'contact',
          toObjectKey: 'contact',
          label: `Matrix ${String(run)}`,
          fromLimit: 1000,
          toLimit: 1000,
        },
      });
      if (created.statusCode >= 400) return created;
      return call('DELETE', `/associations/${associationContract.parse(created.json()).id}`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  // Records of the business's Pet object, each made for its try, and relations between two.
  'record.create': {
    run: (call, run) =>
      call('POST', '/objects/matrix_pet/records', {
        inBusiness: true,
        payload: { fields: { pet_name: `Matrix ${String(run)}` } },
      }),
  },
  'record.update': {
    run: async (call, run) => {
      const id = await matrixPet(`Owned ${String(run)}`);
      const read = await call('GET', `/objects/matrix_pet/records/${id}`, {
        inBusiness: true,
        payload: undefined,
      });
      return call('PATCH', `/objects/matrix_pet/records/${id}`, {
        inBusiness: true,
        payload: { owner: null, revision: read.json<{ ownerRevision: string }>().ownerRevision },
      });
    },
  },
  'record.trash': {
    run: async (call, run) =>
      call('DELETE', `/objects/matrix_pet/records/${await matrixPet(`Old ${String(run)}`)}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'record.restore': {
    run: async (call, run) =>
      call(
        'POST',
        `/objects/matrix_pet/records/${await matrixPet(`Back ${String(run)}`, true)}/restore`,
        { inBusiness: true, payload: {} },
      ),
  },
  'relation.create': {
    run: async (call, run) =>
      call('POST', '/associations/relations', {
        inBusiness: true,
        payload: {
          associationId: matrixPetFriend,
          firstRecordId: await matrixPet(`Ann ${String(run)}`),
          secondRecordId: await matrixPet(`Bea ${String(run)}`),
        },
      }),
  },
  'relation.delete': {
    run: async (call, run) => {
      const [first, second] = [
        await matrixPet(`Cy ${String(run)}`),
        await matrixPet(`Di ${String(run)}`),
      ];
      const made = await database.as('crm_owner', (sql) =>
        sql.one<{ id: string }>(
          `insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id,
                                         source_kind)
           values ($1, $2, $3, $4, 'system') returning id`,
          [
            matrixBusiness,
            parsePublicId('link_type', matrixPetFriend),
            parsePublicId('custom', first),
            parsePublicId('custom', second),
          ],
        ),
      );
      return call('DELETE', `/associations/relations/${toPublicId('record_link', made.id)}`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  'contact.link_company': {
    run: (call) =>
      call('PUT', `/contacts/${matrixContact}/companies/${matrixCompany}`, {
        inBusiness: true,
        payload: { primary: true },
      }),
  },
  'contact.unlink_company': {
    run: (call) =>
      call('DELETE', `/contacts/${matrixContact}/companies/${matrixCompany}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'tag.assign': {
    run: (call) =>
      call('PUT', `/records/${matrixContact}/tags/${matrixTag}`, { inBusiness: true, payload: {} }),
  },
  'tag.remove': {
    run: (call) =>
      call('DELETE', `/records/${matrixContact}/tags/${matrixTag}`, {
        inBusiness: true,
        payload: undefined,
      }),
  },
  'tag_rules.update': {
    run: async (call) => {
      const current = await call('GET', '/tag-configuration', {
        inBusiness: true,
        payload: undefined,
      });
      const { rules } = tagConfiguration.parse(current.json());
      return call('PUT', '/tag-rules', {
        inBusiness: true,
        payload: { ...rules, suggestSimilar: !rules.suggestSimilar },
      });
    },
  },
  'tag.update': {
    run: async (call) => {
      const current = await call('GET', '/tag-configuration', {
        inBusiness: true,
        payload: undefined,
      });
      const definition = tagConfiguration
        .parse(current.json())
        .items.find((item) => item.id === matrixTag);
      if (definition === undefined) throw new Error('Missing matrix definition.');
      return call('PUT', `/tags/${definition.id}`, {
        inBusiness: true,
        payload: {
          name: definition.name,
          description: 'Updated definition.',
          groupId: definition.groupId,
          revision: definition.revision,
        },
      });
    },
  },
  'tag_group.create': {
    run: (call, run) =>
      call('POST', '/tag-groups', {
        inBusiness: true,
        payload: { name: `Group ${String(run)}`, description: 'Permission matrix group.' },
      }),
  },
  'tag_group.update': {
    run: async (call, run) => {
      const created = await examples['tag_group.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing tag group example.');
      if (created.statusCode >= 400) return created;
      const current = tagGroup.parse(created.json());
      return call('PUT', `/tag-groups/${current.id}`, {
        inBusiness: true,
        payload: { name: current.name, description: 'Updated group.', revision: current.revision },
      });
    },
  },
  'deal.create': {
    run: async (call, run) => {
      const response = await call('GET', '/pipelines', { payload: undefined, inBusiness: true });
      const pipeline = pipelineConfiguration.parse(response.json()).items[0];
      const stage = pipeline?.stages[0];
      if (pipeline === undefined || stage === undefined) throw new Error('Missing seeded stage.');
      return call('POST', '/deals', {
        inBusiness: true,
        payload: {
          name: `Deal ${String(run)}`,
          pipelineId: pipeline.id,
          stageId: stage.id,
          currency: 'KES',
        },
      });
    },
  },
  'deal.update': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const current = deal.parse(created.json());
      return call('PUT', `/deals/${current.id}`, {
        inBusiness: true,
        payload: {
          name: 'Updated deal',
          pipelineId: current.pipelineId,
          stageId: current.stageId,
          currency: current.currency,
          revision: current.revision,
        },
      });
    },
  },
  // The opportunity dialog, each on a deal made for the try: its owner from the revision it
  // is at, yourself as a follower, and no contacts from the revision of having none. A role
  // that may not make a deal is refused there, for the same permission.
  'deal.assign_owner': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const { id } = deal.parse(created.json());
      const before = await call('GET', `/deals/${id}/details`, {
        inBusiness: true,
        payload: undefined,
      });
      const { ownerRevision } = dealDetails.parse(before.json());
      return call('PUT', `/deals/${id}/owner`, {
        payload: { owner: 'me', revision: ownerRevision },
        inBusiness: true,
      });
    },
  },
  'deal.add_followers': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const { id } = deal.parse(created.json());
      return call('POST', `/deals/${id}/followers`, {
        payload: { followers: ['me'] },
        inBusiness: true,
      });
    },
  },
  'deal.remove_followers': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const { id } = deal.parse(created.json());
      return call('DELETE', `/deals/${id}/followers`, {
        payload: { followers: ['me'] },
        inBusiness: true,
      });
    },
  },
  'deal.set_contacts': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const { id } = deal.parse(created.json());
      const before = await call('GET', `/deals/${id}/details`, {
        inBusiness: true,
        payload: undefined,
      });
      const { contactsRevision } = dealDetails.parse(before.json());
      return call('PUT', `/deals/${id}/contacts`, {
        payload: { primaryContactId: null, additionalContactIds: [], revision: contactsRevision },
        inBusiness: true,
      });
    },
  },
  // A deal made for the try, marked won in a bulk change of one.
  'deal.bulk': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const { id } = deal.parse(created.json());
      return call('POST', '/deals/bulk', {
        payload: { action: 'set_status', ids: [id], status: 'won' },
        inBusiness: true,
      });
    },
  },
  'deal.trash': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const { id } = deal.parse(created.json());
      return call('DELETE', `/deals/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  'deal.restore': {
    run: async (call, run) => {
      const created = await examples['deal.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing deal example.');
      if (created.statusCode >= 400) return created;
      const { id } = deal.parse(created.json());
      const trashed = await call('DELETE', `/deals/${id}`, {
        inBusiness: true,
        payload: undefined,
      });
      if (trashed.statusCode >= 400) return trashed;
      return call('POST', `/deals/${id}/restore`, { inBusiness: true, payload: {} });
    },
  },
  'record.purge': {
    run: (call) =>
      call('DELETE', `/trash/${matrixTrashed}`, { inBusiness: true, payload: undefined }),
  },
  'field.create': {
    run: (call, run) =>
      call('POST', '/fields', {
        inBusiness: true,
        payload: {
          objectKey: 'contact',
          key: `matrix_${String(run)}`,
          label: `Matrix ${String(run)}`,
          description: 'Permission matrix field.',
          valueType: 'text',
          options: [],
          currency: null,
          aiFillSources: [],
          aiOverwrite: 'ask',
          archived: false,
        },
      }),
  },
  'field.update': {
    run: async (call, run) => {
      const created = await examples['field.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing field example.');
      if (created.statusCode >= 400) return created;
      const field = fieldDefinition.parse(created.json());
      return call('PUT', `/fields/${field.id}`, {
        inBusiness: true,
        payload: {
          label: field.label,
          description: 'Updated description.',
          options: [],
          aiFillSources: [],
          aiOverwrite: 'never',
          archived: false,
          revision: field.revision,
        },
      });
    },
  },
  // Field folders. Each example makes what it needs first, so a role that may not make a
  // folder is refused there, naming the same permission.
  'field_folder.create': {
    run: (call, run) =>
      call('POST', '/field-folders', {
        inBusiness: true,
        payload: { objectKey: 'contact', name: `Matrix folder ${String(run)}` },
      }),
  },
  'field_folder.rename': {
    run: async (call, run) => {
      const created = await examples['field_folder.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing field folder example.');
      if (created.statusCode >= 400) return created;
      const folder = fieldFolder.parse(created.json());
      return call('PUT', `/field-folders/${folder.id}`, {
        inBusiness: true,
        payload: { name: `Renamed folder ${String(run)}`, revision: folder.revision },
      });
    },
  },
  'field_folder.reorder': {
    run: async (call) => {
      const current = await call('GET', '/field-folders?objectKey=contact', {
        inBusiness: true,
        payload: undefined,
      });
      const { items } = fieldFolderList.parse(current.json());
      return call('PUT', '/field-folders/order', {
        inBusiness: true,
        payload: { objectKey: 'contact', folderIds: items.map((folder) => folder.id).reverse() },
      });
    },
  },
  'field_folder.delete': {
    run: async (call, run) => {
      const created = await examples['field_folder.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing field folder example.');
      if (created.statusCode >= 400) return created;
      const { id } = fieldFolder.parse(created.json());
      return call('DELETE', `/field-folders/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  'field.move': {
    run: async (call, run) => {
      const folder = await examples['field_folder.create']?.run(call, run);
      const field = await examples['field.create']?.run(call, run);
      if (folder === undefined || field === undefined) throw new Error('Missing field examples.');
      if (folder.statusCode >= 400) return folder;
      if (field.statusCode >= 400) return field;
      return call('POST', `/field-folders/${fieldFolder.parse(folder.json()).id}/fields`, {
        inBusiness: true,
        payload: { fieldIds: [fieldDefinition.parse(field.json()).id] },
      });
    },
  },
  // The order of a folder's fields: a new folder with one field moved into it, so the list
  // sent is exactly the folder's fields.
  'field.reorder': {
    run: async (call, run) => {
      const moved = await examples['field.move']?.run(call, run);
      if (moved === undefined) throw new Error('Missing field move example.');
      if (moved.statusCode >= 400) return moved;
      const folder = fieldFolder.parse(moved.json());
      const listed = await call('GET', `/custom-fields?folderId=${folder.id}`, {
        inBusiness: true,
        payload: undefined,
      });
      return call('PUT', `/field-folders/${folder.id}/fields/order`, {
        inBusiness: true,
        payload: { fieldIds: customFieldList.parse(listed.json()).items.map(({ id }) => id) },
      });
    },
  },
  // Deleting a field for good, with the confirmation its deletion reads.
  'field.delete': {
    run: async (call, run) => {
      const created = await examples['field.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing field example.');
      if (created.statusCode >= 400) return created;
      const { id } = fieldDefinition.parse(created.json());
      const read = await call('GET', `/fields/${id}/deletion`, {
        inBusiness: true,
        payload: undefined,
      });
      return call('POST', `/fields/${id}/delete`, {
        inBusiness: true,
        payload: { confirmation: fieldDeletion.parse(read.json()).confirmation },
      });
    },
  },
  // Custom values and their folders.
  'custom_value.create': {
    run: (call, run) =>
      call('POST', '/custom-values', {
        inBusiness: true,
        payload: { name: `Matrix value ${String(run)}`, value: 'Mon to Fri, 9 to 5' },
      }),
  },
  'custom_value.update': {
    run: async (call, run) => {
      const created = await examples['custom_value.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing custom value example.');
      if (created.statusCode >= 400) return created;
      const value = customValue.parse(created.json());
      return call('PUT', `/custom-values/${value.id}`, {
        inBusiness: true,
        payload: {
          name: value.name,
          value: 'Every day, 8 to 6',
          folderId: null,
          revision: value.revision,
        },
      });
    },
  },
  'custom_value.move': {
    run: async (call, run) => {
      const folder = await examples['custom_value_folder.create']?.run(call, run);
      const created = await examples['custom_value.create']?.run(call, run);
      if (folder === undefined || created === undefined)
        throw new Error('Missing custom value examples.');
      if (folder.statusCode >= 400) return folder;
      if (created.statusCode >= 400) return created;
      return call('POST', '/custom-values/move', {
        inBusiness: true,
        payload: {
          valueIds: [customValue.parse(created.json()).id],
          folderId: customValueFolder.parse(folder.json()).id,
        },
      });
    },
  },
  'custom_value.delete': {
    run: async (call, run) => {
      const created = await examples['custom_value.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing custom value example.');
      if (created.statusCode >= 400) return created;
      const { id } = customValue.parse(created.json());
      return call('DELETE', `/custom-values/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  // Several at once: the same permission as one.
  'custom_value.delete_many': {
    run: async (call, run) => {
      const created = await examples['custom_value.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing custom value example.');
      if (created.statusCode >= 400) return created;
      const { id } = customValue.parse(created.json());
      return call('POST', '/custom-values/delete', {
        inBusiness: true,
        payload: { valueIds: [id] },
      });
    },
  },
  'custom_value_folder.create': {
    run: (call, run) =>
      call('POST', '/custom-value-folders', {
        inBusiness: true,
        payload: { name: `Matrix value folder ${String(run)}` },
      }),
  },
  'custom_value_folder.rename': {
    run: async (call, run) => {
      const created = await examples['custom_value_folder.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing custom value folder example.');
      if (created.statusCode >= 400) return created;
      const folder = customValueFolder.parse(created.json());
      return call('PUT', `/custom-value-folders/${folder.id}`, {
        inBusiness: true,
        payload: { name: `Renamed value folder ${String(run)}`, revision: folder.revision },
      });
    },
  },
  'custom_value_folder.delete': {
    run: async (call, run) => {
      const created = await examples['custom_value_folder.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing custom value folder example.');
      if (created.statusCode >= 400) return created;
      const { id } = customValueFolder.parse(created.json());
      return call('DELETE', `/custom-value-folders/${id}`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  'pipelines.save': {
    run: async (call) => {
      const current = await call('GET', '/pipelines', { payload: undefined, inBusiness: true });
      const { revision, items } = pipelineConfiguration.parse(current.json());
      return call('PUT', '/pipelines', { payload: { revision, items }, inBusiness: true });
    },
  },
  // One pipeline by itself, each from the configuration's revision: the first moved to
  // the first place, the first copied, and a copy deleted (it holds no deal). A role that
  // may not copy one has none to delete, and is refused for the same permission.
  'pipeline.move': {
    run: async (call) => {
      const current = await call('GET', '/pipelines', { payload: undefined, inBusiness: true });
      const { revision, items } = pipelineConfiguration.parse(current.json());
      return call('POST', `/pipelines/${items[0]?.id ?? ''}/move`, {
        payload: { position: 1, revision },
        inBusiness: true,
      });
    },
  },
  'pipeline.duplicate': {
    run: async (call) => {
      const current = await call('GET', '/pipelines', { payload: undefined, inBusiness: true });
      const { revision, items } = pipelineConfiguration.parse(current.json());
      return call('POST', `/pipelines/${items[0]?.id ?? ''}/duplicate`, {
        payload: { revision },
        inBusiness: true,
      });
    },
  },
  'pipeline.delete': {
    run: async (call, run) => {
      const copied = await examples['pipeline.duplicate']?.run(call, run);
      if (copied === undefined) throw new Error('Missing pipeline example.');
      if (copied.statusCode >= 400) return copied;
      const { revision, items } = pipelineConfiguration.parse(copied.json());
      return call('DELETE', `/pipelines/${items[1]?.id ?? ''}`, {
        payload: { revision },
        inBusiness: true,
      });
    },
  },
  'opportunity_settings.update': {
    run: async (call) => {
      const current = await call('GET', '/opportunity-settings', {
        payload: undefined,
        inBusiness: true,
      });
      const { canManage: _canManage, ...settings } = opportunitySettings.parse(current.json());
      return call('PUT', '/opportunity-settings', { payload: settings, inBusiness: true });
    },
  },
  'duplicate_settings.update': {
    run: async (call) => {
      const current = await call('GET', '/contact-duplicate-settings', {
        payload: undefined,
        inBusiness: true,
      });
      const { canManage: _canManage, ...settings } = duplicateSettings.parse(current.json());
      return call('PUT', '/contact-duplicate-settings', { payload: settings, inBusiness: true });
    },
  },
  // The matrix contact and a second one, said not to be the same person.
  'contact_duplicates.reject': {
    run: async (call) => {
      const { agency_id: agencyId } = await database.as('crm_owner', (sql) =>
        sql.one<{ agency_id: string }>('select agency_id from tenancy.businesses where id = $1', [
          matrixBusiness,
        ]),
      );
      const twin = await database.fixtures.contact({
        agencyId,
        businessId: matrixBusiness,
        actorKind: 'system',
        correlationId: randomUUID(),
      });
      return call('POST', '/contacts/duplicate-groups/reject', {
        payload: {
          by: 'name',
          valueKey: 'matrix twin',
          contactIds: [matrixContact, toPublicId('contact', twin.id)],
        },
        inBusiness: true,
      });
    },
  },
  // Two new contacts, one merged into the other, with the revisions the preview gives. A
  // role refused the preview is refused the merge for the same permission, before its
  // revisions are read.
  'contact.merge': {
    run: async (call) => {
      const { agency_id: agencyId } = await database.as('crm_owner', (sql) =>
        sql.one<{ agency_id: string }>('select agency_id from tenancy.businesses where id = $1', [
          matrixBusiness,
        ]),
      );
      const context = {
        agencyId,
        businessId: matrixBusiness,
        actorKind: 'system' as const,
        correlationId: randomUUID(),
      };
      const kept = toPublicId('contact', (await database.fixtures.contact(context)).id);
      const twin = toPublicId('contact', (await database.fixtures.contact(context)).id);
      const preview = await call('GET', `/contacts/${kept}/merge-preview?mergeIds=${twin}`, {
        payload: undefined,
        inBusiness: true,
      });
      const revisions =
        preview.statusCode === 200
          ? Object.fromEntries(
              contactMergePreview
                .parse(preview.json())
                .contacts.map((each) => [each.id, each.revision]),
            )
          : { [kept]: '0'.repeat(64), [twin]: '0'.repeat(64) };
      return call('POST', `/contacts/${kept}/merge`, {
        payload: { mergeIds: [twin], revisions },
        inBusiness: true,
      });
    },
  },
  'business.update_profile': {
    run: (call) =>
      call('PUT', '/business-profile', {
        payload: {
          name: 'Profile matrix',
          timezone: 'UTC',
          locale: 'en',
          currency: 'USD',
          address: null,
          logoFileId: null,
        },
        inBusiness: true,
      }),
  },
  'team.invite': {
    run: async (call, run) => {
      const current = team.parse(
        (await call('GET', '/team', { payload: undefined, inBusiness: true })).json(),
      );
      const role = current.roles.find((each) => each.key === 'member');
      if (role === undefined) throw new Error('The member role is missing.');
      return call('POST', '/team/invitations', {
        payload: { email: `invite-${String(run)}@example.test`, roleId: role.id },
        inBusiness: true,
      });
    },
  },
  'team.resend_invitation': {
    run: async (call) => {
      const current = team.parse(
        (await call('GET', '/team', { payload: undefined, inBusiness: true })).json(),
      );
      const invitation = current.invitations.find((each) => each.email === 'pending@example.test');
      if (invitation === undefined) throw new Error('The pending invitation is missing.');
      return call('POST', `/team/invitations/${invitation.id}/resend`, {
        payload: {},
        inBusiness: true,
      });
    },
  },
  'team.revoke_invitation': {
    run: async (call) => {
      const current = team.parse(
        (await call('GET', '/team', { payload: undefined, inBusiness: true })).json(),
      );
      const invitation = current.invitations.find((each) => each.email === 'pending@example.test');
      if (invitation === undefined) throw new Error('The pending invitation is missing.');
      return call('DELETE', `/team/invitations/${invitation.id}`, {
        payload: undefined,
        inBusiness: true,
      });
    },
  },
  'team.remove_member': {
    run: async (call) => {
      const current = team.parse(
        (await call('GET', '/team', { payload: undefined, inBusiness: true })).json(),
      );
      const member = current.members.find((each) => !each.isSelf && !each.isOwner);
      if (member === undefined) throw new Error('The removable member is missing.');
      return call('DELETE', `/team/members/${member.id}`, { payload: undefined, inBusiness: true });
    },
  },
  // Settings → Users: adding a person is an invitation with their details, and a person
  // who manages the team may always save their own details with the role they have.
  'team.add_user': {
    run: async (call, run) => {
      const current = team.parse(
        (await call('GET', '/team', { payload: undefined, inBusiness: true })).json(),
      );
      const role = current.roles.find((each) => each.key === 'member');
      if (role === undefined) throw new Error('The member role is missing.');
      return call('POST', '/users', {
        payload: {
          firstName: 'Matrix',
          lastName: `Person ${String(run)}`,
          email: `add-user-${String(run)}@example.test`,
          roleId: role.id,
        },
        inBusiness: true,
      });
    },
  },
  'team.update_user': {
    run: async (call) => {
      const current = userList.parse(
        (await call('GET', '/users', { payload: undefined, inBusiness: true })).json(),
      );
      // Someone of the business who is not an owner, else the caller: the agency's own team
      // works in the business without being one of its members.
      const person =
        current.items.find(
          (each) => each.status === 'active' && each.userType === 'account' && !each.isOwner,
        ) ?? current.items.find((each) => each.isSelf && each.userType === 'account');
      if (person === undefined) throw new Error('Nobody of the business can be changed.');
      return call('PUT', `/users/${person.id}`, {
        payload: {
          firstName: person.firstName || 'Matrix',
          lastName: person.lastName || 'Member',
          roleId: person.roleId,
        },
        inBusiness: true,
      });
    },
  },
  'api_key.create': {
    run: (call, run) =>
      call('POST', '/api-keys', {
        payload: { name: `Matrix ${String(run)}`, scopes: ['files.upload'] },
        inBusiness: true,
      }),
  },
  'api_key.revoke': {
    run: async (call) => {
      const keys = apiKeyList.parse(
        (await call('GET', '/api-keys', { payload: undefined, inBusiness: true })).json(),
      );
      const key = keys.items.find((each) => each.name === 'Matrix key');
      if (key === undefined) throw new Error('The matrix key is missing.');
      return call('DELETE', `/api-keys/${key.id}`, { payload: undefined, inBusiness: true });
    },
  },
  'agency.require_two_factor': {
    run: (call) =>
      call('PUT', '/agency/two-factor-requirement', {
        payload: { required: false },
        inBusiness: false,
      }),
  },
  'business.create': {
    run: (call, run) =>
      call('POST', '/businesses', {
        payload: { name: `Matrix ${String(run)}`, timezone: 'UTC', currency: 'USD' },
        inBusiness: false,
      }),
  },
  'file.create': {
    run: (call) =>
      call('POST', '/files?filename=logo.png', {
        payload: png,
        type: 'image/png',
        inBusiness: true,
      }),
  },
  'record.file.attach': {
    run: (call) =>
      call('POST', `/records/${matrixContact}/files?filename=plan.png`, {
        payload: png,
        type: 'image/png',
        inBusiness: true,
      }),
  },
  // The role's own upload is deleted; a role that can't upload is refused either way.
  'record.file.remove': {
    run: async (call) => {
      const uploaded = await call('POST', `/records/${matrixContact}/files?filename=drop.png`, {
        payload: png,
        type: 'image/png',
        inBusiness: true,
      });
      const fileId =
        uploaded.statusCode === 201
          ? uploaded.json<{ id: string }>().id
          : toPublicId('file', '01890a5d-ac96-774b-bcce-b302099a8057');
      return call('DELETE', `/records/${matrixContact}/files/${fileId}`, {
        inBusiness: true,
        payload: undefined,
      });
    },
  },
  // Settings → Import data. The file is uploaded first, as the page does; a role that may
  // not upload is refused the import of the matrix business's own file all the same.
  'import.start': {
    run: async (call, run) => {
      const uploaded = await call('POST', '/files?filename=matrix.csv', {
        payload: Buffer.from(`First,Email\r\nMatrix,import-${String(run)}@example.test\r\n`),
        type: 'text/csv',
        inBusiness: true,
      });
      return call('POST', '/imports', {
        inBusiness: true,
        payload: {
          fileId:
            uploaded.statusCode === 201 ? uploaded.json<{ id: string }>().id : matrixImportFile,
          object: 'contact',
          mode: 'create',
          mapping: [
            { column: 0, target: { kind: 'attribute', attribute: 'firstName' } },
            { column: 1, target: { kind: 'attribute', attribute: 'email' } },
          ],
        },
      });
    },
  },
  // An import that has ended is answered as it is, so stopping it is allowed or refused by
  // the role alone.
  'import.cancel': {
    run: (call) =>
      call('POST', `/imports/${matrixImport}/cancel`, { inBusiness: true, payload: undefined }),
  },
  'contact.create': {
    run: (call, run) =>
      call('POST', '/contacts', {
        payload: { firstName: 'Matrix', emails: [`matrix-${String(run)}@example.test`] },
        inBusiness: true,
      }),
  },
  'contact.update': {
    // A name, and the time zone with the revision it is based on: the same permission
    // guards both, and the settings that decide whether the contact is sent anything.
    run: async (call, run) => {
      const before = await call('GET', `/contacts/${matrixContact}`, {
        inBusiness: true,
        payload: undefined,
      });
      const { preferencesRevision } = contact.parse(before.json());
      const timeZone = run % 2 === 0 ? 'UTC' : 'Africa/Nairobi';
      const saved = await call('PATCH', `/contacts/${matrixContact}`, {
        payload: { lastName: `Run ${String(run)}`, timeZone, preferencesRevision },
        inBusiness: true,
      });
      if (saved.statusCode === 200)
        expect(contact.parse(saved.json())).toMatchObject({ timeZone, doNotContact: false });
      return saved;
    },
  },
  // The contact page: the owner from the revision it is at, and yourself as a follower.
  'contact.assign_owner': {
    run: async (call, run) => {
      const before = await call('GET', `/contacts/${matrixContact}/details`, {
        inBusiness: true,
        payload: undefined,
      });
      const { ownerRevision } = contactDetails.parse(before.json());
      return call('PUT', `/contacts/${matrixContact}/owner`, {
        payload: { owner: run % 2 === 0 ? 'me' : null, revision: ownerRevision },
        inBusiness: true,
      });
    },
  },
  'contact.add_followers': {
    run: (call) =>
      call('POST', `/contacts/${matrixContact}/followers`, {
        payload: { followers: ['me'] },
        inBusiness: true,
      }),
  },
  'contact.remove_followers': {
    run: (call) =>
      call('DELETE', `/contacts/${matrixContact}/followers`, {
        payload: { followers: ['me'] },
        inBusiness: true,
      }),
  },
  // One address added, then the newest one labelled and removed, each from the revision
  // the contact's addresses are at. A role that may not add one has none to change, and is
  // refused for its role before any address is looked for.
  'contact.add_address': {
    run: (call, run) =>
      call('POST', `/contacts/${matrixContact}/addresses`, {
        payload: { kind: 'phone', value: `+2547${String(10_000_000 + run)}` },
        inBusiness: true,
      }),
  },
  'contact.update_address': {
    run: async (call) => {
      const { address, revision } = await matrixAddress(call);
      return call('PATCH', `/contacts/${matrixContact}/addresses/${address}`, {
        payload: { label: 'work', revision },
        inBusiness: true,
      });
    },
  },
  'contact.remove_address': {
    run: async (call) => {
      const { address, revision } = await matrixAddress(call);
      return call('DELETE', `/contacts/${matrixContact}/addresses/${address}`, {
        payload: { revision },
        inBusiness: true,
      });
    },
  },
  // Do not disturb for text messages, on and off by turns, from the revision it is at. Do
  // not contact itself is left off: other examples send this contact a reply.
  'contact.set_dnd': {
    run: async (call, run) => {
      const before = await call('GET', `/contacts/${matrixContact}/details`, {
        inBusiness: true,
        payload: undefined,
      });
      const { dnd } = contactDetails.parse(before.json());
      return call('PUT', `/contacts/${matrixContact}/dnd`, {
        payload: {
          all: false,
          channels: run % 2 === 0 ? ['sms'] : [],
          reason: 'Matrix: asked for no text messages.',
          revision: dnd.revision,
        },
        inBusiness: true,
      });
    },
  },
  // Contact memory: a fact the assistant kept about the matrix contact, rewritten from the
  // revision it is at, and removed for good.
  'contact_fact.correct': {
    run: async (call, run) => {
      const fact = await matrixFact(call, run);
      return call('PATCH', `/contacts/${matrixContact}/memory/facts/${fact.id}`, {
        payload: {
          statement: `Prefers a call after six (run ${String(run)})`,
          revision: fact.revision,
        },
        inBusiness: true,
      });
    },
  },
  'contact_fact.delete': {
    run: async (call, run) => {
      const fact = await matrixFact(call, run);
      return call('DELETE', `/contacts/${matrixContact}/memory/facts/${fact.id}`, {
        payload: undefined,
        inBusiness: true,
      });
    },
  },
  'contact.trash': {
    run: (call) =>
      call('DELETE', `/contacts/${matrixContact}`, { payload: undefined, inBusiness: true }),
  },
  // The matrix contact's owner cleared in a bulk change of one: a change that needs no
  // permission beside the contact's own.
  'contact.bulk': {
    run: (call) =>
      call('POST', '/contacts/bulk', {
        payload: { action: 'assign_owner', owner: null, selection: { ids: [matrixContact] } },
        inBusiness: true,
      }),
  },
  // A bulk action started for the try, then stopped. It has ended by then, so stopping it
  // changes nothing, and is still the caller's to ask.
  'contact.bulk.cancel': {
    run: async (call, run) => {
      const started = await examples['contact.bulk']?.run(call, run);
      if (started === undefined) throw new Error('Missing bulk example.');
      if (started.statusCode >= 400) return started;
      const { id } = contactBulkAction.parse(started.json());
      return call('POST', `/contacts/bulk-actions/${id}/cancel`, {
        payload: {},
        inBusiness: true,
      });
    },
  },
  'contact.restore': {
    run: (call) =>
      call('POST', `/contacts/${matrixContact}/restore`, { payload: {}, inBusiness: true }),
  },
  'tag.create': {
    run: (call, run) =>
      call('POST', '/tags', { payload: { name: `matrix ${String(run)}` }, inBusiness: true }),
  },
  'tag.ensure_lead_sources': {
    run: (call) =>
      call('POST', '/lead-sources/tags', {
        payload: { sources: ['google_ads'] },
        inBusiness: true,
      }),
  },
  // Each reads the revision first: every role changes the same business's settings.
  'external_tracking.update': {
    run: async (call) => {
      const read = await call('GET', '/external-tracking', {
        inBusiness: true,
        payload: undefined,
      });
      const { revision } = externalTracking.parse(read.json());
      return call('PUT', '/external-tracking', {
        inBusiness: true,
        payload: {
          pageViews: true,
          formCapture: true,
          allowedDomains: [],
          visitorIds: 'unless_opted_out',
          revision,
        },
      });
    },
  },
  'external_tracking.regenerate': {
    run: async (call) => {
      const read = await call('GET', '/external-tracking', {
        inBusiness: true,
        payload: undefined,
      });
      const { revision } = externalTracking.parse(read.json());
      return call('POST', '/external-tracking/regenerate', {
        inBusiness: true,
        payload: { revision },
      });
    },
  },
  'crm.score_rule.create': {
    run: (call) =>
      call('POST', '/scoring/rules', {
        inBusiness: true,
        payload: {
          when: { action: 'appointment_booked' },
          calculation: 'add',
          points: 10,
        },
      }),
  },
  'crm.score_rule.update': {
    run: async (call, run) => {
      const created = await examples['crm.score_rule.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing score rule example.');
      if (created.statusCode >= 400) return created;
      const rule = scoreRule.parse(created.json());
      return call('PUT', `/scoring/rules/${rule.id}`, {
        inBusiness: true,
        payload: {
          when: { action: 'payment_received' },
          calculation: 'subtract',
          points: 5,
          revision: rule.revision,
        },
      });
    },
  },
  'crm.score_rule.delete': {
    run: async (call, run) => {
      const created = await examples['crm.score_rule.create']?.run(call, run);
      if (created === undefined) throw new Error('Missing score rule example.');
      if (created.statusCode >= 400) return created;
      const { id } = scoreRule.parse(created.json());
      return call('DELETE', `/scoring/rules/${id}`, { inBusiness: true, payload: undefined });
    },
  },
  'crm.score_profile.update': {
    run: (call) =>
      call('PUT', '/scoring', {
        inBusiness: true,
        payload: {
          name: 'Engagement Score',
          description: 'Updated scoring rules description',
        },
      }),
  },
  'crm.score_profile.publish': {
    run: async (call) => {
      const read = await call('GET', '/scoring', { inBusiness: true, payload: undefined });
      if (read.statusCode >= 400) return read;
      const current = scoreProfile.parse(read.json());
      return call('POST', '/scoring/publish', {
        inBusiness: true,
        payload: { revision: current.revision },
      });
    },
  },
  'crm.contact_score.set': {
    run: (call) =>
      call('PUT', `/contacts/${matrixContact}/engagement-score`, {
        inBusiness: true,
        payload: { score: 100 },
      }),
  },
};

/**
 * A fact the assistant kept about the matrix contact, stored as its command stores one,
 * and read back as anyone in the business reads it: its id, and the revision a change to
 * it is made on.
 */
async function matrixFact(call: Call, run: number): Promise<{ id: string; revision: string }> {
  const stored = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into ai.contact_facts (business_id, contact_id, statement, kind, status,
         created_by_kind)
       values ($1, $2, $3, 'preference', 'proposed', 'ai_agent') returning id`,
      [
        matrixBusiness,
        parsePublicId('contact', matrixContact),
        `Prefers a call after five (run ${String(run)})`,
      ],
    ),
  );
  const read = await call('GET', `/contacts/${matrixContact}/memory/facts`, {
    inBusiness: true,
    payload: undefined,
  });
  expect(read.statusCode, read.body).toBe(200);
  const fact = contactFacts
    .parse(read.json())
    .items.find((item) => item.id === toPublicId('contact_fact', stored.id));
  if (fact === undefined) throw new Error('The matrix fact was not listed.');
  return { id: fact.id, revision: fact.revision };
}

/**
 * A message to the in-app assistant from the matrix business, where a model could be asked:
 * the agency has a provider's key, which a business uses until it chooses its own. Each
 * message starts a thread of its own, so none waits on another's turn.
 */
async function startAssistantTurn(call: Call): Promise<LightMyRequestResponse> {
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into ai.provider_keys (agency_id, business_id, provider, base_url, default_model)
       select b.agency_id, null, 'openai_compatible', 'https://models.example.com/v1', 'matrix-model'
       from tenancy.businesses b
       where b.id = $1 and not exists (
         select 1 from ai.provider_keys k where k.agency_id = b.agency_id and k.business_id is null)`,
      [matrixBusiness],
    ),
  );
  return call('POST', '/assistant/threads', {
    inBusiness: true,
    payload: { message: 'What can you help with?', page: { route: '/forms' } },
  });
}

// Endpoints that change nothing, though their method isn't GET, and why.
const changesNothing: Readonly<Record<string, string>> = {
  runReportQuery:
    'It counts what the caller may see and answers; nothing is saved. It still needs reports.view, which packages/modules/reporting/src/engine.int.test.ts proves.',
  getAssistantContext:
    'It reads what is missing on a page and whether a model could be asked; nothing is saved and no model is called.',
  createFileLink: "It signs a link to read a file, and reading isn't gated (ADR-020).",
  createRecordFileLink:
    'It signs a five-minute link to a file of a record the caller can see; nothing is saved. apps/server/src/record-files-http.int.test.ts proves another record or business gets none.',
  inspectImportFile:
    'It reads an uploaded file and answers what it holds; nothing is saved. It still needs contacts.import, which packages/modules/crm/src/imports/imports.int.test.ts proves.',
  previewImport:
    'It shows what the first rows of a file would become; nothing is saved. It still needs contacts.import, proved in the same place.',
  createImportErrorFileLink:
    'It signs a link to the file of rows an import did not apply. It still needs contacts.import, proved in the same place.',
  previewContactEmailChecks:
    'It counts what verifying the email addresses of a selection would do; nothing is queued or checked. It still needs contacts.manage, which the role test below proves.',
  createContactExportLink:
    "It signs a link to an export's file; nothing is saved. It still needs contacts.export, which packages/modules/crm/src/contacts/bulk-more.int.test.ts proves.",
  discoverMailboxServers: 'It resolves server suggestions without signing in or saving a mailbox.',
  validateAutomation:
    'It checks a document it was sent and answers what it found; nothing is saved.',
  previewLeadSource:
    'It reads an address it was sent as a submission would and answers what a lead arriving by it would be; nothing is saved (ADR-091). A form it names is read as anyone in the business may read it, which packages/modules/forms/src/lead-source.int.test.ts proves.',
  previewMessageTemplate:
    'It fills in text it was sent with sample values it was sent; nothing is saved or sent.',
  renderEmailPreview:
    'It fills in a template or content it was sent, with sample values or the values of a contact anyone in the business may read; nothing is saved, queued or sent, and no link is issued (ADR-092). packages/modules/messaging/src/email-formatted.int.test.ts proves another business finds neither the template nor the contact.',
};

/**
 * Endpoints that run the command a proposal holds, and so have no command or permission of
 * their own: each needs what that proposal's command needs. The proposal matrix below
 * tries every one of them, for a proposal of each kind, as every built-in role.
 */
const runsAProposal: Readonly<Record<string, string>> = {
  applyProposal: "It runs the proposal's command, as whoever applies it.",
  dismissProposal: "It decides the proposal, which takes what the proposal's command takes.",
  undoProposal: "It runs the command that reverses the proposal's own.",
};

/**
 * Endpoints that change only what is the caller's own, and so take no permission and run no
 * command: a role cannot take a person's own bell away. Each is tried as every built-in
 * role in the last test of this file, and none takes anyone's id.
 */
const changesOnlyYourOwn: Readonly<Record<string, string>> = {
  markNotificationRead: 'It marks one of your own notifications read.',
  markAllNotificationsRead: 'It marks your own notifications read, up to one you were shown.',
  updateNotificationPreferences:
    'It chooses which kinds of notification you receive; the change is kept in the audit log.',
};

let people = 0;

/** The contact in the business of the person signed in last, for the contact commands. */
let matrixContact = '';
/** A contact already in the trash, for the purge. */
let matrixTrashed = '';
let matrixCompany = '';
let matrixMailbox = '';
/** That mailbox as the inbox names it, a conversation in it, its message and the address. */
let matrixSendingAccount = '';
let matrixConversation = '';
let matrixMessage = '';
let matrixIdentity = '';
/** The same contact's phone, to call. */
let matrixPhoneIdentity = '';
let matrixTag = '';
let matrixField = '';
let matrixAiField = '';
let matrixNote = '';
let matrixTask = '';
/** A draft automation, a calendar that takes no bookings, and a connected Twilio account. */
let matrixAutomation = '';
let matrixCalendar = '';
let matrixTemplate = '';
let matrixSmsConnection = '';
/** A number that account owns, not yet registered. */
let matrixSmsNumber = '';
/** A registered number that takes calls, for the Phone System settings. */
let matrixPhoneNumber = '';
/** A call of the business, to read its details and recordings. */
let matrixCall = '';
/** An import of the business that has ended, and the stored file it read. */
let matrixImport = '';
let matrixImportFile = '';
/** A web chat widget of the business, and what its settings page would save for it. */
let matrixWidget = '';
const matrixWidgetInput = {
  name: 'Matrix widget',
  allowedOrigins: ['https://matrix.example'],
  enabled: true,
  settings: {
    title: 'Chat with us',
    greeting: '',
    emailRequired: true,
    marketingConsentWording: null,
  },
};

const matrixDocument = {
  name: 'Matrix automation',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
};
/** A draft form of the business that lists a website, so it can be published as it is. */
let matrixForm = '';
/** A model server the business connected, which asks for no key. */
let matrixAiConnection = '';
/** The person signed in last, and their business: a saved view is a person's own. */
let matrixPerson = '';
let matrixBusiness = '';
/** The business's Pet object, and an association of Pet with itself. */
let matrixPetObject = '';
let matrixPetFriend = '';

/** A record of the business's Pet, written as the records command writes one. */
async function matrixPet(name: string, trashed = false): Promise<string> {
  const made = await database.as('crm_owner', async (sql) => {
    const record = await sql.one<{ id: string }>(
      `insert into crm.records (business_id, kind, object_type_id)
       values ($1, 'custom', $2) returning id`,
      [matrixBusiness, matrixPetObject],
    );
    await sql.query(
      `insert into crm.custom_records (business_id, id, object_type_id, title, deleted_at,
                                       created_by_kind)
       values ($1, $2, $3, $4, case when $5 then now() end, 'system')`,
      [matrixBusiness, record.id, matrixPetObject, name, trashed],
    );
    return record;
  });
  return toPublicId('custom', made.id);
}

/**
 * A new contact view of the person signed in last, with the visibility given, as they read
 * it, with its fresh revision. It's added directly, since a viewer can't save one and only
 * owners and admins can share one, and each command is tried on the person's own view.
 */
/** The matrix contact's newest phone number, or a made-up id when it has none, and the revision. */
async function matrixAddress(call: Call): Promise<{ address: string; revision: string }> {
  const read = await call('GET', `/contacts/${matrixContact}/details`, {
    inBusiness: true,
    payload: undefined,
  });
  const details = contactDetails.parse(read.json());
  return {
    address:
      details.addresses.findLast((each) => each.kind === 'phone')?.id ??
      toPublicId('contact_identity', parsePublicId('contact', matrixContact) ?? ''),
    revision: details.addressesRevision,
  };
}

async function matrixViewFor(call: Call, visibility: 'private' | 'shared') {
  const added = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.saved_views (business_id, object_type_id, name, visibility, owner_user_id, columns)
       select business_id, id, 'Matrix view', $2, $3, '["name"]' from crm.object_types
       where business_id = $1 and kind = 'contact' returning id`,
      [matrixBusiness, visibility, matrixPerson],
    ),
  );
  const response = await call('GET', '/views?object=contact', {
    inBusiness: true,
    payload: undefined,
  });
  const id = toPublicId('saved_view', added.id);
  const current = viewList.parse(response.json()).items.find((item) => item.id === id);
  if (current === undefined) throw new Error('Missing matrix view.');
  return current;
}

/** A new text snippet of the matrix business, added directly. */
async function matrixSnippet(): Promise<string> {
  const added = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into messaging.snippets (business_id, kind, name, body, created_by_kind)
       values ($1, 'text', 'Matrix ' || uuidv7()::text, 'Running late.', 'system') returning id`,
      [matrixBusiness],
    ),
  );
  return toPublicId('snippet', added.id);
}

/**
 * A pending call for the matrix contact, left by a run of an automation of its own, added
 * directly; with the revision a person would close or assign it from.
 */
async function matrixManualAction(): Promise<{ id: string; revision: string }> {
  const action = await database.as('crm_owner', async (sql) => {
    const automation = await sql.one<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values ($1, 'Manual ' || uuidv7()::text, $2::jsonb, 'system') returning id`,
      [matrixBusiness, JSON.stringify(matrixDocument)],
    );
    const version = await sql.one<{ id: string }>(
      `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
       values ($1, $2, 1, $3::jsonb, 'system') returning id`,
      [matrixBusiness, automation.id, JSON.stringify(matrixDocument)],
    );
    const enrolment = await sql.one<{ id: string }>(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, status, reentry_key, current_step, correlation_id)
       values ($1, $2, $3, $4, 'waiting', uuidv7(), 'call', uuidv7()) returning id`,
      [matrixBusiness, automation.id, version.id, parsePublicId('contact', matrixContact)],
    );
    return sql.one<{ id: string }>(
      `insert into automation.manual_actions
         (business_id, automation_id, enrolment_id, step_key, contact_id, kind)
       values ($1, $2, $3, 'call', $4, 'call') returning id`,
      [matrixBusiness, automation.id, enrolment.id, parsePublicId('contact', matrixContact)],
    );
  });
  return {
    id: toPublicId('manual_action', action.id),
    revision: createHash('sha256')
      .update(JSON.stringify([action.id, 'pending', null]))
      .digest('hex'),
  };
}

/**
 * A run of the matrix contact that failed at its one step, in a published automation of
 * its own, added directly.
 */
async function matrixFailedRun(): Promise<string> {
  const run = await database.as('crm_owner', async (sql) => {
    const automation = await sql.one<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values ($1, 'Failed ' || uuidv7()::text, $2::jsonb, 'system') returning id`,
      [matrixBusiness, JSON.stringify(matrixDocument)],
    );
    const version = await sql.one<{ id: string }>(
      `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
       values ($1, $2, 1, $3::jsonb, 'system') returning id`,
      [matrixBusiness, automation.id, JSON.stringify(matrixDocument)],
    );
    await sql.query(
      `update automation.automations set status = 'active', published_version_id = $2 where id = $1`,
      [automation.id, version.id],
    );
    const enrolment = await sql.one<{ id: string }>(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, status, reentry_key, exit_reason,
          finished_at, correlation_id)
       values ($1, $2, $3, $4, 'failed', uuidv7(), 'conflict', now(), uuidv7()) returning id`,
      [matrixBusiness, automation.id, version.id, parsePublicId('contact', matrixContact)],
    );
    await sql.query(
      `insert into automation.step_runs
         (business_id, enrolment_id, automation_id, version_id, step_key, status, finished_at)
       values ($1, $2, $3, $4, 'pause', 'failed', now())`,
      [matrixBusiness, enrolment.id, automation.id, version.id],
    );
    return enrolment;
  });
  return toPublicId('automation_enrolment', run.id);
}

/**
 * A run of the matrix contact that waits at its one step for a day, in a published
 * automation of its own, added directly.
 */
async function matrixWaitingRun(): Promise<string> {
  const run = await database.as('crm_owner', async (sql) => {
    const automation = await sql.one<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values ($1, 'Waiting ' || uuidv7()::text, $2::jsonb, 'system') returning id`,
      [matrixBusiness, JSON.stringify(matrixDocument)],
    );
    const version = await sql.one<{ id: string }>(
      `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
       values ($1, $2, 1, $3::jsonb, 'system') returning id`,
      [matrixBusiness, automation.id, JSON.stringify(matrixDocument)],
    );
    await sql.query(
      `update automation.automations set status = 'active', published_version_id = $2 where id = $1`,
      [automation.id, version.id],
    );
    const enrolment = await sql.one<{ id: string }>(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, status, reentry_key, wake_at,
          state, correlation_id)
       values ($1, $2, $3, $4, 'waiting', uuidv7(), now() + interval '1 day',
               '{"sequence": 1}', uuidv7()) returning id`,
      [matrixBusiness, automation.id, version.id, parsePublicId('contact', matrixContact)],
    );
    await sql.query(
      `insert into automation.step_runs
         (business_id, enrolment_id, automation_id, version_id, step_key, status, explanation)
       values ($1, $2, $3, $4, 'pause', 'waiting', 'Waiting 1 day.')`,
      [matrixBusiness, enrolment.id, automation.id, version.id],
    );
    return enrolment;
  });
  return toPublicId('automation_enrolment', run.id);
}

/** A new automation folder of the matrix business, at revision 1, added directly. */
async function matrixAutomationFolder(): Promise<string> {
  const folder = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into automation.folders (business_id, name, created_by_kind)
       values ($1, 'Matrix ' || uuidv7()::text, 'system') returning id`,
      [matrixBusiness],
    ),
  );
  return toPublicId('automation_folder', folder.id);
}

/** A new draft automation of the matrix business, or one already deleted, added directly. */
async function matrixSpareAutomation(deleted: boolean): Promise<string> {
  const spare = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into automation.automations
         (business_id, name, draft, created_by_kind, status, archived_at)
       values ($1, 'Spare', $2::jsonb, 'system', $3, case when $4 then now() end) returning id`,
      [matrixBusiness, JSON.stringify(matrixDocument), deleted ? 'archived' : 'draft', deleted],
    ),
  );
  return toPublicId('automation', spare.id);
}

/** The matrix automation as it is now: each save and publish starts from its draft version. */
async function matrixAutomationFor(call: Call) {
  const response = await call('GET', `/automations/${matrixAutomation}`, {
    inBusiness: true,
    payload: undefined,
  });
  return automationView.parse(response.json());
}

/**
 * A new member of the matrix business with no schedule stored, added directly: the command
 * is tried on someone each role may or may not manage, never on the person signed in.
 */
async function matrixScheduleMember(): Promise<string> {
  const teammate = await database.fixtures.user();
  const membership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select $1, b.agency_id, b.id, r.id from tenancy.businesses b
       join tenancy.roles r on r.agency_id = b.agency_id and r.scope = 'business' and r.key = 'member'
       where b.id = $2 returning id`,
      [teammate.id, matrixBusiness],
    ),
  );
  return toPublicId('membership', membership.id);
}

/**
 * A calendar of the matrix business that takes bookings, with one host: the matrix calendar
 * itself is a draft with nobody on it. Made once for each matrix business.
 */
let matrixBooking:
  { business: string; calendar: string; calendarId: string; hostId: string } | undefined;
async function matrixBookings() {
  if (matrixBooking?.business === matrixBusiness) return matrixBooking;
  const host = await database.fixtures.user();
  const business = matrixBusiness;
  const calendar = await database.as('crm_owner', async (sql) => {
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select $1, b.agency_id, b.id, r.id from tenancy.businesses b
       join tenancy.roles r on r.agency_id = b.agency_id and r.scope = 'business' and r.key = 'member'
       where b.id = $2`,
      [host.id, business],
    );
    const made = await sql.one<{ id: string }>(
      `insert into calendar.calendars(business_id,name,kind,timezone,booking_slug,is_active)
       values($1,'Matrix bookings','personal','UTC','matrix-bookings',true) returning id`,
      [business],
    );
    await sql.query(
      `insert into calendar.calendar_members(business_id,calendar_id,user_id) values($1,$2,$3)`,
      [business, made.id, host.id],
    );
    return made;
  });
  matrixBooking = {
    business,
    calendar: toPublicId('calendar', calendar.id),
    calendarId: calendar.id,
    hostId: host.id,
  };
  return matrixBooking;
}

/** An hour nobody of the matrix has taken yet: each appointment command gets its own. */
let matrixSlots = 0;
function matrixSlot(): { startsAt: string; endsAt: string } {
  const start = Date.UTC(2031, 0, 1) + (matrixSlots += 1) * 7_200_000;
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3_600_000).toISOString(),
  };
}

/** A new appointment with the matrix host, and its revision as the caller reads it. */
async function matrixAppointmentFor(call: Call): Promise<{ id: string; revision: string }> {
  const { business, calendarId, hostId } = await matrixBookings();
  const { startsAt, endsAt } = matrixSlot();
  const made = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at, source)
       values ($1, $2, $3, $4, 'Matrix visit', $5, $6, 'user') returning id`,
      [business, calendarId, parsePublicId('contact', matrixContact), hostId, startsAt, endsAt],
    ),
  );
  const id = toPublicId('appointment', made.id);
  const response = await call('GET', `/appointments/${id}`, {
    inBusiness: true,
    payload: undefined,
  });
  return { id, revision: appointmentDetail.parse(response.json()).revision };
}

/**
 * The matrix person's Google connection, connected again if an example disconnected it,
 * as the callback stores one: a sealed token no worker opens here.
 */
async function matrixGoogleConnection(): Promise<void> {
  await database.as('crm_owner', (sql) =>
    sql.query(
      `with secret as (
         insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         select agency_id, id, 'calendar.google.refresh_token', 1,
                decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')
         from tenancy.businesses where id = $1
         returning business_id, id)
       insert into calendar.google_connections
         (business_id, user_id, status, google_sub, google_email, secret_id)
       select business_id, $2, 'connected', 'matrix-sub', 'matrix@example.test', id from secret
       on conflict (business_id, user_id) do update
         set status = 'connected', disconnected_reason = null, disconnected_at = null,
             secret_id = excluded.secret_id`,
      [matrixBusiness, matrixPerson],
    ),
  );
}

/** A calendar group of the matrix's business, made for one example to rename or delete. */
async function matrixCalendarGroup(): Promise<string> {
  const group = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      'insert into calendar.calendar_groups (business_id, name) values ($1, $2) returning id',
      [matrixBusiness, `Group ${randomUUID()}`],
    ),
  );
  return toPublicId('calendar_group', group.id);
}

/**
 * A blocked slot of a member of the matrix's business, made for one example to change or
 * remove, with the revision a manager reads; someone who may not read it is refused before
 * any revision would be checked.
 */
async function matrixBlockedSlotFor(call: Call) {
  const membershipId = await matrixScheduleMember();
  const made = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.blocked_slots (business_id, user_id, starts_at, ends_at, title)
       select business_id, user_id, '2026-11-02T06:00:00Z', '2026-11-06T15:00:00Z', 'Leave'
       from tenancy.memberships where id = $1 returning id`,
      [parsePublicId('membership', membershipId)],
    ),
  );
  const id = toPublicId('blocked_slot', made.id);
  const response = await call('GET', `/calendars/blocked-slots/${id}`, {
    inBusiness: true,
    payload: undefined,
  });
  return {
    id,
    membershipId,
    revision:
      response.statusCode === 200 ? blockedSlot.parse(response.json()).revision : 'a'.repeat(64),
  };
}

async function matrixCalendarFor(call: Call) {
  const response = await call('GET', `/calendars/${matrixCalendar}`, {
    inBusiness: true,
    payload: undefined,
  });
  return calendarConfiguration.parse(response.json());
}

async function matrixTaskFor(call: Call) {
  const response = await call('GET', '/tasks?status=all', { inBusiness: true, payload: undefined });
  const current = taskList.parse(response.json()).items.find((item) => item.id === matrixTask);
  if (current === undefined) throw new Error('Missing matrix task.');
  return current;
}

async function matrixNoteFor(call: Call) {
  const response = await call('GET', `/records/${matrixContact}/notes`, {
    inBusiness: true,
    payload: undefined,
  });
  const current = recordNotes.parse(response.json()).items.find((item) => item.id === matrixNote);
  if (current === undefined) throw new Error('Missing matrix note.');
  return current;
}

/** The matrix form as the caller reads it now: anyone in the business may read it. */
async function matrixFormFor(call: Call) {
  const response = await call('GET', `/forms/${matrixForm}`, {
    inBusiness: true,
    payload: undefined,
  });
  return formContract.parse(response.json());
}

/**
 * A new submission to the matrix form that reached no contact, added directly: the only
 * kind anyone may discard, and each role is tried on one of its own.
 */
async function matrixUnattachedSubmission(): Promise<string> {
  const submission = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into forms.submissions (business_id, form_id, data, contact_outcome)
       values ($1, $2, '{"answers": [], "skipped": []}', 'unresolved') returning id`,
      [matrixBusiness, parsePublicId('form', matrixForm)],
    ),
  );
  return toPublicId('form_submission', submission.id);
}

/** The matrix template's revision as the caller reads it now: anyone may read it. */
async function matrixTemplateRevision(call: Call): Promise<string> {
  const response = await call('GET', `/message-templates/${matrixTemplate}`, {
    inBusiness: true,
    payload: undefined,
  });
  return messageTemplate.parse(response.json()).revision;
}

/** The matrix conversation's revision as the caller reads it now: anyone may read it. */
async function matrixConversationRevision(call: Call): Promise<string> {
  const response = await call('GET', `/conversations/${matrixConversation}`, {
    inBusiness: true,
    payload: undefined,
  });
  return conversation.parse(response.json()).revision;
}

/**
 * Someone with the built-in role given, in a new agency with one business: agency staff for
 * an agency role, a member of the business for a business one. Signed in, it calls the API
 * at the agency or in the business.
 */
async function signedInWith(role: BuiltInRole): Promise<Call> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.withTenant(business.context, async (sql) => {
    // Only the permission boundary is exercised here; no worker opens this fixture.
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets(agency_id,business_id,purpose,key_version,enc,ciphertext)
       values($1,$2,'mailbox.credentials',1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex')) returning id`,
      [agency.id, business.id],
    );
    const channel = await sql.one<{ id: string }>(
      `insert into messaging.channel_accounts(business_id,channel,name)
       values($1,'email','Matrix mailbox') returning id`,
      [business.id],
    );
    await sql.query(
      `insert into messaging.mailboxes(business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id)
       values($1,$2,'matrix@example.test','password','mail.example.test',465,'tls','matrix',$3)`,
      [business.id, channel.id, secret.id],
    );
    matrixMailbox = toPublicId('mailbox', channel.id);
    const automation = await sql.one<{ id: string }>(
      `insert into automation.automations(business_id,name,draft,created_by_kind)
       values($1,$2,$3::jsonb,'system') returning id`,
      [business.id, matrixDocument.name, JSON.stringify(matrixDocument)],
    );
    matrixAutomation = toPublicId('automation', automation.id);
    const calendar = await sql.one<{ id: string }>(
      `insert into calendar.calendars(business_id,name,kind,timezone,booking_slug,is_active)
       values($1,'Matrix calendar','personal','UTC','matrix',false) returning id`,
      [business.id],
    );
    matrixCalendar = toPublicId('calendar', calendar.id);
    const template = await sql.one<{ id: string }>(
      `insert into messaging.templates(business_id,name,subject,body,created_by_kind)
       values($1,'Matrix guide','Hello','Hi {{contact.firstName}}','system') returning id`,
      [business.id],
    );
    matrixTemplate = toPublicId('template', template.id);
    const company = await sql.one<{ id: string }>(
      `with record as (insert into crm.records(business_id,kind,object_type_id) select app.business_id(),'company',id from crm.object_types where kind='company' returning id) insert into crm.companies(business_id,id,name,created_by_kind) select app.business_id(),id,'Matrix company','system' from record returning id`,
    );
    matrixCompany = toPublicId('company', company.id);
    await sql.query(
      `insert into crm.link_types(business_id,key,from_object_type_id,to_object_type_id,label,reverse_label,allows_primary) select app.business_id(),'contact_company',c.id,o.id,'Company','Person',true from crm.object_types c cross join crm.object_types o where c.kind='contact' and o.kind='company'`,
    );
    // This matrix isolates catalog grants. The separate policy tests cover admins-only creation.
    await sql.query(
      "insert into crm.settings (business_id, tag_creation) values ($1, 'everyone')",
      [business.id],
    );
    const tag = await sql.one<{ id: string }>(
      "insert into crm.tags (business_id, name, created_by_kind) values ($1, 'Matrix definition', 'system') returning id",
      [business.id],
    );
    matrixTag = toPublicId('tag', tag.id);
    const pipeline = await sql.one<{ id: string }>(
      "insert into crm.pipelines (business_id, name) values ($1, 'Matrix') returning id",
      [business.id],
    );
    await sql.query(
      "insert into crm.pipeline_stages (business_id, pipeline_id, name, position) values ($1, $2, 'New', 0)",
      [business.id, pipeline.id],
    );
  });
  matrixContact = toPublicId('contact', (await database.fixtures.contact(business.context)).id);
  // The contact wrote to the matrix mailbox, as the inbox sync stores it.
  await database.withTenant(business.context, async (sql) => {
    const contactId = parsePublicId('contact', matrixContact);
    const accountId = parsePublicId('mailbox', matrixMailbox) ?? '';
    const identity = await sql.one<{ id: string }>(
      `insert into crm.contact_identities
         (business_id, contact_id, kind, value, value_normalized, is_primary)
       values ($1, $2, 'email', 'maya@example.test', 'maya@example.test', true) returning id`,
      [business.id, contactId],
    );
    const stored = await sql.one<{ id: string }>(
      'insert into messaging.conversations (business_id, contact_id) values ($1, $2) returning id',
      [business.id, contactId],
    );
    const message = await sql.one<{ id: string }>(
      `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
         direction, status, body_text, from_address, author_kind, author_id)
       values ($1, $2, 'email', $3, 'inbound', 'received', 'Is June 13 still open?',
         'maya@example.test', 'contact', $4) returning id`,
      [business.id, stored.id, accountId, contactId],
    );
    matrixSendingAccount = toPublicId('channel_account', accountId);
    matrixConversation = toPublicId('conversation', stored.id);
    matrixMessage = toPublicId('message', message.id);
    matrixIdentity = toPublicId('contact_identity', identity.id);
    const phone = await sql.one<{ id: string }>(
      `insert into crm.contact_identities
         (business_id, contact_id, kind, value, value_normalized, is_primary)
       values ($1, $2, 'phone', '+15005550006', '+15005550006', true) returning id`,
      [business.id, contactId],
    );
    matrixPhoneIdentity = toPublicId('contact_identity', phone.id);
  });
  const trashed = await database.fixtures.contact(business.context);
  await database.withTenant(business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [trashed.id]),
  );
  matrixTrashed = toPublicId('contact', trashed.id);
  await database.withTenant(business.context, async (sql) => {
    const field = await sql.one<{ id: string }>(
      `insert into crm.field_definitions(business_id,object_type_id,key,label,description,value_type,created_by_kind) select app.business_id(),id,'matrix_value','Matrix value','Permission matrix value.','text','system' from crm.object_types where kind='contact' returning id`,
    );
    matrixField = toPublicId('field', field.id);
    const savedNote = await sql.one<{ id: string }>(
      `insert into crm.notes(business_id,record_id,body,body_text,author_kind)
       values($1,$2,$3::jsonb,'Call Maya.','system') returning id`,
      [
        business.id,
        parsePublicId('contact', matrixContact),
        JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Call Maya.' }] }],
        }),
      ],
    );
    matrixNote = toPublicId('note', savedNote.id);
    const savedTask = await sql.one<{ id: string }>(
      `insert into crm.tasks(business_id,record_id,title,created_by_kind)
       values($1,$2,'Call Maya','system') returning id`,
      [business.id, parsePublicId('contact', matrixContact)],
    );
    matrixTask = toPublicId('task', savedTask.id);
    const ai = await sql.one<{ id: string }>(
      `insert into crm.field_definitions(business_id,object_type_id,key,label,description,value_type,created_by_kind) select app.business_id(),id,'matrix_ai','Matrix AI','Permission matrix confirmation.','text','system' from crm.object_types where kind='contact' returning id`,
    );
    matrixAiField = toPublicId('field', ai.id);
    await sql.query(
      `insert into crm.field_values(business_id,record_id,field_id,value_type,value_text,source_kind) values($1,$2,$3,'text','Suggested','ai_agent')`,
      [business.id, parsePublicId('contact', matrixContact), ai.id],
    );
  });
  // A custom object, Pet, and an association of Pet with itself.
  await database.withTenant(business.context, async (sql) => {
    const pet = await sql.one<{ id: string; primary_field_id: string }>(
      `insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                     primary_field_id)
       values ($1, uuidv7(), 'custom', 'matrix_pet', 'Pet', 'Pets', uuidv7())
       returning id, primary_field_id`,
      [business.id],
    );
    await sql.query(
      `insert into crm.field_definitions (business_id, id, object_type_id, key, label, description,
                                          value_type, folder_id, created_by_kind)
       select $1, $2, $3, 'pet_name', 'Pet name', 'Its name.', 'text', f.id, 'system'
       from crm.field_folders f where f.object_type_id = $3 limit 1`,
      [business.id, pet.primary_field_id, pet.id],
    );
    const friend = await sql.one<{ id: string }>(
      `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
                                   label, reverse_label, from_limit, to_limit)
       values ($1, 'matrix_pet_friend', $2, $2, 'Friend', 'Friend', 1000, 1000) returning id`,
      [business.id, pet.id],
    );
    matrixPetObject = pet.id;
    matrixPetFriend = toPublicId('link_type', friend.id);
  });
  const email = `role-${String(++people)}@harborlights.example`;
  const { id: userId } = await authentication.createUser({
    email,
    name: 'Dana Brooks',
    password: PASSWORD,
    emailVerified: true,
  });
  matrixPerson = userId;
  matrixBusiness = business.id;
  const teammate = await database.fixtures.user();
  await database.as('crm_owner', async (sql) => {
    // The connection is the worker's to save, after Twilio accepts the credentials; no
    // worker opens this one. A phone number is one business's in the whole install.
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets(agency_id,business_id,purpose,key_version,enc,ciphertext)
       values($1,$2,'sms.twilio.credentials',1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex')) returning id`,
      [agency.id, business.id],
    );
    const connection = await sql.one<{ id: string }>(
      `insert into messaging.provider_connections(agency_id,business_id,provider,label,account_ref,secret_id)
       values($1,$2,'twilio','Matrix account','AC' || repeat('0',32),$3) returning id`,
      [agency.id, business.id, secret.id],
    );
    matrixSmsConnection = toPublicId('sms_connection', connection.id);
    // A second account with calling set up, for calling tokens; the first stays to set up.
    const voice = await sql.one<{ id: string }>(
      `insert into messaging.provider_connections(agency_id,business_id,provider,label,account_ref,secret_id)
       values($1,$2,'twilio','Matrix calling','AC' || repeat('1',32),$3) returning id`,
      [agency.id, business.id, secret.id],
    );
    await sql.query(
      `insert into messaging.voice_setups (business_id, connection_id, status, key_sid, secret_id, finished_at)
       values ($1, $2, 'ready', 'SK' || repeat('1',32), $3, now())`,
      [business.id, voice.id, secret.id],
    );
    const widget = await sql.one<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name)
       values ($1, 'webchat', 'Matrix widget') returning id`,
      [business.id],
    );
    await sql.query(
      `insert into messaging.webchat_widgets (business_id, id, public_key, allowed_origins)
       values ($1, $2, substr(encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 1, 32), '{https://matrix.example}')`,
      [business.id, widget.id],
    );
    matrixWidget = toPublicId('webchat_widget', widget.id);
    const form = await sql.one<{ id: string }>(
      `insert into forms.forms (business_id, name, definition, public_key, allowed_origins)
       values ($1, 'Matrix form', $2::jsonb,
         substr(encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 1, 32), '{https://matrix.example}')
       returning id`,
      [business.id, JSON.stringify(DEFAULT_FORM_DEFINITION)],
    );
    matrixForm = toPublicId('form', form.id);
    const importFile = await sql.one<{ id: string }>(
      `insert into files.files (agency_id, business_id, storage, storage_key, filename,
                                content_type, size_bytes, sha256, uploaded_by_kind)
       values ($1, $2, 'local', gen_random_uuid()::text, 'matrix.csv', 'text/csv', 0,
               sha256(''::bytea), 'system') returning id`,
      [agency.id, business.id],
    );
    matrixImportFile = toPublicId('file', importFile.id);
    const finished = await sql.one<{ id: string }>(
      `insert into imports.jobs (business_id, source, status, objects, created_by_kind, file_id,
                                 file_name, started_at, finished_at)
       values ($1, 'csv', 'completed', '{contact}', 'system', $2, 'matrix.csv', now(), now())
       returning id`,
      [business.id, importFile.id],
    );
    matrixImport = toPublicId('import', finished.id);
    const aiConnection = await sql.one<{ id: string }>(
      `insert into ai.provider_keys (agency_id, business_id, provider, base_url, default_model)
       values ($1, $2, 'openai_compatible', 'https://models.example.com/v1', 'matrix-model')
       returning id`,
      [agency.id, business.id],
    );
    matrixAiConnection = toPublicId('ai_connection', aiConnection.id);
    matrixSmsNumber = `PN${String(people).padStart(32, '0')}`;
    await sql.query(
      `insert into messaging.provider_numbers(business_id,connection_id,provider_number_ref,e164,capabilities)
       values($1,$2,$3,$4,array['sms'])`,
      [business.id, connection.id, matrixSmsNumber, `+1500555${String(1000 + people)}`],
    );
    const line = await sql.one<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name)
       values ($1, 'sms', 'Matrix line') returning id`,
      [business.id],
    );
    await sql.query(
      `insert into messaging.phone_numbers(business_id,id,e164,provider_connection_id,provider_number_ref,capabilities)
       values($1,$2,$3,$4,$5,array['sms','voice'])`,
      [
        business.id,
        line.id,
        `+1500556${String(1000 + people)}`,
        connection.id,
        `PN${String(people).padStart(31, '0')}1`,
      ],
    );
    matrixPhoneNumber = toPublicId('phone_number', line.id);
    const callRow = await sql.one<{ id: string }>(
      `insert into messaging.calls (business_id, direction, phone_number_id, provider_connection_id,
         local_e164, remote_e164, requested_by_kind, idempotency_key, request_hash)
       values ($1, 'outbound', $2, $3, $4, '+15005550006', 'system', $5, repeat('a', 64)) returning id`,
      [
        business.id,
        line.id,
        connection.id,
        `+1500556${String(1000 + people)}`,
        `matrix-call-${String(people).padStart(16, '0')}`,
      ],
    );
    matrixCall = toPublicId('call', callRow.id);
    const member = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values ($1, 'business', 'member', 'Member', true) returning id`,
      [agency.id],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id) values ($1, $2, $3, $4)`,
      [teammate.id, agency.id, business.id, member.id],
    );
    await sql.query(
      `insert into tenancy.invitations (agency_id, business_id, role_id, email, token_hash, expires_at) values ($1, $2, $3, 'pending@example.test', decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'), now() + interval '7 days')`,
      [agency.id, business.id, member.id],
    );
    await sql.query(
      `insert into tenancy.api_keys (agency_id, business_id, name, key_prefix, key_hash, scopes)
       values ($1, $2, 'Matrix key', 'crm_live_' || substr(md5(gen_random_uuid()::text), 1, 12),
         sha256(gen_random_uuid()::text::bytea), array['tags.manage'])`,
      [agency.id, business.id],
    );
    const { id: roleId } = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, $2, $3, $3, true) on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
      [agency.id, role.scope, role.key],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4)`,
      [userId, agency.id, role.scope === 'agency' ? null : business.id, roleId],
    );
  });
  const { app } = server;
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
    payload: { email, password: PASSWORD },
    // A client of its own, so sign-in's rate limit counts each person apart.
    remoteAddress: `203.0.113.${String(people)}`,
  });
  expect(signIn.statusCode).toBe(200);
  const setCookie = signIn.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((each) => each.split(';')[0] ?? '')
    .join('; ');

  return (method, path, { payload, type = 'application/json', inBusiness }) =>
    app.inject({
      method,
      url: `${API_PREFIX}${path}`,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(payload === undefined ? {} : { 'content-type': type }),
        ...(inBusiness ? { 'business-id': toPublicId('business', business.id) } : {}),
      },
      payload: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
    });
}

describe('the permission matrix', () => {
  it.each(builtInRoles.filter((role) => role.scope === 'agency'))(
    'allows agency $key to upload an agency-shared file',
    async (role) => {
      const call = await signedInWith(role);
      const answer = await call('POST', '/files?filename=shared.png', {
        payload: png,
        type: 'image/png',
        inBusiness: false,
      });
      expect(answer.statusCode, answer.body).toBeLessThan(300);
    },
  );

  it('has an example for every command, and a reason for every other change', () => {
    for (const route of routes) {
      const { operationId, method } = route.endpoint;
      if (method === 'get') continue;
      // Covered by the proposal matrix, which the test after this one holds to this list.
      if (Object.hasOwn(runsAProposal, operationId)) {
        expect(route.command, `${operationId} runs the proposal's command`).toBeUndefined();
        continue;
      }
      // The caller's own bell: tried as every role by the last test of this file.
      if (Object.hasOwn(changesOnlyYourOwn, operationId)) {
        expect(route.command, `${operationId} is the caller's own`).toBeUndefined();
        expect(Object.keys(route.endpoint.params?.shape ?? {})).not.toContain('userId');
        continue;
      }
      if (route.command === undefined) {
        expect(changesNothing, `${operationId} runs no command`).toHaveProperty(operationId);
      } else {
        expect(examples, `${route.command.name} needs an example`).toHaveProperty(
          route.command.name,
        );
      }
    }
  });

  // The test above only meets the routes listed in beforeAll. Routes start.ts adds beside
  // apiRoutes (Google's were) are listed there by hand, and one left out escaped the matrix
  // without a failure. Every endpoint the API publishes must be served here.
  it('serves every endpoint the API publishes, so none escapes the matrix', () => {
    const served = new Set(routes.map((route) => route.endpoint.operationId));
    expect(
      endpoints
        .map((endpoint) => endpoint.operationId)
        // Who is signed in: the server answers GET /me itself (server.ts), with no command.
        .filter((operationId) => operationId !== 'getMe' && !served.has(operationId)),
    ).toEqual([]);
  });

  it('serves the three ways to decide a proposal, and no other change without a command', () => {
    const served = routes
      .filter((route) => Object.hasOwn(runsAProposal, route.endpoint.operationId))
      .map((route) => `${route.endpoint.method} ${route.endpoint.path}`);
    expect(served.sort()).toEqual([
      'post /proposals/{id}/apply',
      'post /proposals/{id}/dismiss',
      'post /proposals/{id}/undo',
    ]);
  });

  /**
   * A proposal waiting in the matrix business, stored as an assistant stores one: a reply
   * to the matrix conversation, or a change of its status.
   */
  async function matrixProposal(
    call: Call,
    kind: 'reply' | 'conversation_status',
  ): Promise<string> {
    const conversationId = parsePublicId('conversation', matrixConversation);
    // The conversation as anyone in the business reads it: its status, and the revision a
    // change of status is made on.
    const read = await call('GET', `/conversations/${matrixConversation}`, {
      inBusiness: true,
      payload: undefined,
    });
    expect(read.statusCode, read.body).toBe(200);
    const { status, revision } = conversation.parse(read.json());
    const row = await database.as('crm_owner', async (sql) => {
      // One proposal of a kind waits for a conversation: the one before it was decided,
      // or is closed here as a newer proposal would close it.
      await sql.query(
        `update ai.proposals set status = 'expired', decided_at = now(), decided_by_kind = 'system'
         where conversation_id = $1 and kind = $2 and status = 'pending'`,
        [conversationId, kind],
      );
      // What a drafted reply is made on: the newest message of the thread that is no note.
      const { thread } = await sql.one<{ thread: string }>(
        `select coalesce(max(seq), 0)::text as thread from messaging.messages
         where conversation_id = $1 and direction <> 'internal'`,
        [conversationId],
      );
      const reply = {
        channel: 'email',
        accountId: matrixSendingAccount,
        to: matrixIdentity,
        subject: null,
        text: 'Hi Maya, June 13 is open.',
      };
      const stored =
        kind === 'reply'
          ? {
              command: {
                name: 'conversation.reply',
                input: {
                  id: matrixConversation,
                  reply: {
                    ...reply,
                    idempotencyKey: `proposal-matrix-${String(++proposalsMade).padStart(12, '0')}`,
                  },
                },
              },
              after: { kind: 'reply', ...reply },
              revision: `thread:${thread}`,
            }
          : {
              command: {
                name: 'conversation.set_status',
                input: { id: matrixConversation, change: { status: 'closed', revision } },
              },
              after: { kind: 'conversation_status', from: status, to: 'closed', until: null },
              revision,
            };
      return sql.one<{ id: string }>(
        `insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command,
           after, autonomy, revision)
         values ($1, 'inbox', $2, $3, 'Proposed in the matrix', $4, $5, 'ask', $6) returning id`,
        [matrixBusiness, kind, conversationId, stored.command, stored.after, stored.revision],
      );
    });
    return toPublicId('proposal', row.id);
  }
  let proposalsMade = 0;

  /**
   * The field the extraction proposals of this matrix fill: one AI may fill from
   * conversations, in the business of the person signed in last.
   */
  let extractedField = '';
  let extractedFieldBusiness = '';
  /** That field's saved value for the matrix contact, as anyone in the business reads it. */
  async function extractedValue(call: Call) {
    const read = await call('GET', `/records/${matrixContact}/fields`, {
      inBusiness: true,
      payload: undefined,
    });
    expect(read.statusCode, read.body).toBe(200);
    const found = recordFields
      .parse(read.json())
      .items.find((item) => item.definition.id === extractedField);
    if (found === undefined) throw new Error('The matrix contact has no extraction field.');
    return found;
  }

  /**
   * A proposal of the extraction assistant waiting about the matrix contact, stored as its
   * job stores one: a fact read in the contact's message, or a value for a field, made on
   * the value saved now.
   */
  async function extractionProposal(
    call: Call,
    kind: 'memory_fact' | 'field_value',
  ): Promise<string> {
    const contactId = parsePublicId('contact', matrixContact);
    if (extractedFieldBusiness !== matrixBusiness) {
      const made = await database.as('crm_owner', (sql) =>
        sql.one<{ id: string }>(
          `insert into crm.field_definitions (business_id, object_type_id, key, label, description,
             value_type, created_by_kind, ai_fill_sources)
           select $1, id, 'matrix_venue', 'Matrix venue', 'Where the event is held.', 'text',
             'system', '{conversations}'
           from crm.object_types where business_id = $1 and kind = 'contact' returning id`,
          [matrixBusiness],
        ),
      );
      extractedField = toPublicId('field', made.id);
      extractedFieldBusiness = matrixBusiness;
    }
    const quote = 'Matrix message';
    const stored =
      kind === 'field_value'
        ? {
            command: {
              name: 'field.value.set',
              input: {
                id: matrixContact,
                fieldId: extractedField,
                value: 'Willow Park barn',
                revision: (await extractedValue(call)).revision,
                aiSource: 'conversations',
                confidence: 0.9,
              },
            },
            after: {
              kind: 'field_value',
              fieldId: extractedField,
              label: 'Matrix venue',
              from: null,
              fromSource: null,
              to: 'Willow Park barn',
            },
            revision: (await extractedValue(call)).revision,
          }
        : await database.as('crm_owner', async (sql) => {
            // The event of a message from the contact: what a fact names as its source.
            const event = await sql.one<{ id: string }>(
              `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                 subject_kind, subject_id, payload)
               select b.agency_id, b.id, 'message.received', 'contact', uuidv7(), 'message', $2,
                 jsonb_build_object('conversationId', $3::text)
               from tenancy.businesses b where b.id = $1 returning id`,
              [
                matrixBusiness,
                parsePublicId('message', matrixMessage),
                parsePublicId('conversation', matrixConversation),
              ],
            );
            const statement = `Prefers a call after five (${String(++proposalsMade)})`;
            return {
              command: {
                name: 'contact_fact.remember',
                input: {
                  id: matrixContact,
                  statement,
                  kind: 'preference',
                  quote,
                  conversationId: matrixConversation,
                  eventIds: [toPublicId('event', event.id)],
                },
              },
              after: { kind: 'memory_fact', statement, factKind: 'preference', quote },
              revision: 'contact',
            };
          });
    const row = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into ai.proposals (business_id, agent, kind, record_id, summary, command, after,
           autonomy, revision)
         values ($1, 'extraction', $2, $3, 'Proposed in the matrix', $4, $5, 'ask', $6)
         returning id`,
        [matrixBusiness, kind, contactId, stored.command, stored.after, stored.revision],
      ),
    );
    return toPublicId('proposal', row.id);
  }

  it.each(builtInRoles)(
    'lets $scope $key decide a proposal exactly when its role allows the proposal’s command',
    async (role) => {
      const call = await signedInWith(role);
      // Consent on record and no quiet hours, so that an allowed reply is taken by the
      // pipeline at whatever hour this runs.
      await database.as('crm_owner', (sql) =>
        sql.query(
          `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
           on conflict (business_id) do update set quiet_hours_enabled = false`,
          [matrixBusiness],
        ),
      );
      await database.as('crm_owner', (sql) =>
        sql.query(
          `insert into messaging.consents
             (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
           values ($1, $2, 'email', 'transactional', 'granted', 'user', 'system')`,
          [matrixBusiness, parsePublicId('contact', matrixContact)],
        ),
      );
      const decide = (id: string, how: 'apply' | 'dismiss' | 'undo') =>
        call('POST', `/proposals/${id}/${how}`, {
          inBusiness: true,
          payload: how === 'apply' ? {} : undefined,
        });
      const expectRefused = (answer: LightMyRequestResponse, permission: string) => {
        expect(answer.statusCode, answer.body).toBe(403);
        expect(problem.parse(answer.json()).permission).toBe(permission);
      };
      const statusOf = async (id: string) => {
        const read = await call('GET', `/proposals/${id}`, {
          inBusiness: true,
          payload: undefined,
        });
        expect(read.statusCode, read.body).toBe(200);
        return proposal.parse(read.json());
      };
      const messages = () =>
        database.as('crm_owner', (sql) =>
          sql.query(
            `select 1 from messaging.messages where business_id = $1 and direction = 'outbound'`,
            [matrixBusiness],
          ),
        );
      const conversationStatus = async () =>
        (
          await database.as('crm_owner', (sql) =>
            sql.one<{ status: string }>(
              'select status from messaging.conversations where id = $1',
              [parsePublicId('conversation', matrixConversation)],
            ),
          )
        ).status;

      // A drafted reply runs conversation.reply, which takes conversations.reply.
      const mayReply = !role.refuses.includes('conversation.reply');
      const dismissed = await matrixProposal(call, 'reply');
      // Everyone in the business reads it, and is told whether deciding it is theirs.
      expect(await statusOf(dismissed)).toMatchObject({ status: 'pending', canDecide: mayReply });
      if (mayReply) {
        expect((await decide(dismissed, 'dismiss')).statusCode).toBe(200);
        expect((await statusOf(dismissed)).status).toBe('dismissed');
      } else {
        expectRefused(await decide(dismissed, 'dismiss'), 'conversations.reply');
        expect((await statusOf(dismissed)).status).toBe('pending');
      }
      const sent = await matrixProposal(call, 'reply');
      if (mayReply) {
        const applied = await decide(sent, 'apply');
        expect(applied.statusCode, applied.body).toBe(200);
        expect(proposal.parse(applied.json()).status).toBe('applied');
        expect(await messages()).toHaveLength(1);
        // A sent message cannot be unsent: refused for what it is, not for who asks.
        const undone = await decide(sent, 'undo');
        expect(undone.statusCode, undone.body).toBe(409);
        expect(problem.parse(undone.json()).detail).toBe(
          'A message that was sent can’t be unsent.',
        );
      } else {
        expectRefused(await decide(sent, 'apply'), 'conversations.reply');
        expectRefused(await decide(sent, 'undo'), 'conversations.reply');
        expect((await statusOf(sent)).status).toBe('pending');
        expect(await messages()).toEqual([]);
      }

      // A change of status runs conversation.set_status, which takes conversations.manage.
      const mayManage = !role.refuses.includes('conversation.set_status');
      const closing = await matrixProposal(call, 'conversation_status');
      expect((await statusOf(closing)).canDecide).toBe(mayManage);
      if (mayManage) {
        expect((await decide(closing, 'apply')).statusCode).toBe(200);
        expect(await conversationStatus()).toBe('closed');
        const undone = await decide(closing, 'undo');
        expect(undone.statusCode, undone.body).toBe(200);
        expect(proposal.parse(undone.json()).status).toBe('undone');
        expect(await conversationStatus()).toBe('open');
      } else {
        expectRefused(await decide(closing, 'apply'), 'conversations.manage');
        expectRefused(await decide(closing, 'undo'), 'conversations.manage');
        expectRefused(await decide(closing, 'dismiss'), 'conversations.manage');
        expect((await statusOf(closing)).status).toBe('pending');
        expect(await conversationStatus()).toBe('open');
      }

      // What the extraction assistant read. A fact to keep runs contact_fact.remember,
      // which takes contacts.manage; undoing it removes the fact.
      const mayRemember = !role.refuses.includes('contact.update');
      const factsKept = async () =>
        (
          await database.as('crm_owner', (sql) =>
            sql.query(
              `select 1 from ai.contact_facts where contact_id = $1 and proposal_id is not null`,
              [parsePublicId('contact', matrixContact)],
            ),
          )
        ).length;
      const keptBefore = await factsKept();
      const remembering = await extractionProposal(call, 'memory_fact');
      expect(await statusOf(remembering)).toMatchObject({
        status: 'pending',
        recordId: matrixContact,
        canDecide: mayRemember,
      });
      if (mayRemember) {
        expect((await decide(remembering, 'apply')).statusCode).toBe(200);
        expect(await factsKept()).toBe(keptBefore + 1);
        const undone = await decide(remembering, 'undo');
        expect(undone.statusCode, undone.body).toBe(200);
        expect(proposal.parse(undone.json()).status).toBe('undone');
      } else {
        expectRefused(await decide(remembering, 'apply'), 'contacts.manage');
        expectRefused(await decide(remembering, 'undo'), 'contacts.manage');
        expectRefused(await decide(remembering, 'dismiss'), 'contacts.manage');
        expect((await statusOf(remembering)).status).toBe('pending');
      }
      expect(await factsKept()).toBe(keptBefore);

      // A value for a field runs field.value.set, which takes fields.values; undoing it
      // puts the field back as it was: empty.
      const mayFill = !role.refuses.includes('field.value.set');
      const filling = await extractionProposal(call, 'field_value');
      expect((await statusOf(filling)).canDecide).toBe(mayFill);
      if (mayFill) {
        const applied = await decide(filling, 'apply');
        expect(applied.statusCode, applied.body).toBe(200);
        expect((await extractedValue(call)).value).toBe('Willow Park barn');
        const undone = await decide(filling, 'undo');
        expect(undone.statusCode, undone.body).toBe(200);
      } else {
        expectRefused(await decide(filling, 'apply'), 'fields.values');
        expectRefused(await decide(filling, 'undo'), 'fields.values');
        expectRefused(await decide(filling, 'dismiss'), 'fields.values');
        expect((await statusOf(filling)).status).toBe('pending');
      }
      expect((await extractedValue(call)).value).toBeNull();
    },
  );

  // Choosing a campaign's mailbox is writing the campaign: whoever may write campaigns
  // reads the business's mailboxes as the campaign screens need them, without managing
  // mailboxes, and is shown nothing that signs in to one. Anyone else is refused.
  it.each(builtInRoles)(
    "lets $scope $key read a campaign's mailboxes exactly when it may write campaigns",
    async (role) => {
      const call = await signedInWith(role);
      await addCampaignRecords(database, matrixBusiness);
      const here = { inBusiness: true, payload: undefined };
      const granted = permissionsOf(
        { scope: role.scope, key: role.key, isBuiltin: true, permissions: [] },
        'business',
      );
      const answer = await call('GET', '/email-campaign-mailboxes', here);
      if (!granted.has('campaigns.manage')) {
        expect(answer.statusCode, answer.body).toBe(403);
        expect(problem.parse(answer.json()).permission).toBe('campaigns.manage');
        return;
      }
      expect(answer.statusCode, answer.body).toBe(200);
      expect(emailCampaignMailboxList.parse(answer.json()).items).toContainEqual(
        expect.objectContaining({ name: 'Campaign mailbox', useForCampaigns: true }),
      );
      expect(answer.body).not.toMatch(/mail\.example\.test|smtp|imap|secret|password/i);
      // The mailboxes' own settings stay with whoever manages mailboxes.
      if (!granted.has('mailboxes.manage')) {
        const settings = await call('GET', '/mailboxes', here);
        expect(settings.statusCode, settings.body).toBe(403);
      }
    },
  );

  it.each(builtInRoles)(
    'lets $scope $key read whether calls can be made exactly when it may read calls',
    async (role) => {
      const call = await signedInWith(role);
      const granted = permissionsOf(
        { scope: role.scope, key: role.key, isBuiltin: true, permissions: [] },
        'business',
      );
      const answer = await call('GET', '/calls/availability', {
        inBusiness: true,
        payload: undefined,
      });
      if (!granted.has('calls.read')) {
        expect(answer.statusCode, answer.body).toBe(403);
        expect(problem.parse(answer.json()).permission).toBe('calls.read');
        return;
      }
      expect(answer.statusCode, answer.body).toBe(200);
      expect(answer.json()).toEqual({ available: true, unavailable: null });
    },
  );

  it.each(builtInRoles)(
    'lets $scope $key read a call and its recordings exactly when it may read calls',
    async (role) => {
      const call = await signedInWith(role);
      const granted = permissionsOf(
        { scope: role.scope, key: role.key, isBuiltin: true, permissions: [] },
        'business',
      );
      const readCall = await call('GET', `/calls/${matrixCall}`, {
        inBusiness: true,
        payload: undefined,
      });
      const recordings = await call('GET', `/calls/${matrixCall}/recordings`, {
        inBusiness: true,
        payload: undefined,
      });
      if (!granted.has('calls.read')) {
        expect(readCall.statusCode, readCall.body).toBe(403);
        expect(problem.parse(readCall.json()).permission).toBe('calls.read');
        expect(recordings.statusCode, recordings.body).toBe(403);
        expect(problem.parse(recordings.json()).permission).toBe('calls.read');
        return;
      }
      expect(readCall.statusCode, readCall.body).toBe(200);
      expect(readCall.json()).toHaveProperty('id', matrixCall);
      expect(recordings.statusCode, recordings.body).toBe(200);
      expect(recordings.json()).toEqual({ data: [] });
    },
  );

  // The confirm dialog of "Verify emails" counts what it would do: for whoever may start it.
  it.each(builtInRoles)(
    'lets $scope $key preview Verify emails exactly when it may manage contacts',
    async (role) => {
      const call = await signedInWith(role);
      const granted = permissionsOf(
        { scope: role.scope, key: role.key, isBuiltin: true, permissions: [] },
        'business',
      );
      const answer = await call('POST', '/contacts/bulk/verify-emails/preview', {
        inBusiness: true,
        payload: { selection: { ids: [matrixContact] } },
      });
      if (!granted.has('contacts.manage')) {
        expect(answer.statusCode, answer.body).toBe(403);
        expect(problem.parse(answer.json()).permission).toBe('contacts.manage');
        return;
      }
      expect(answer.statusCode, answer.body).toBe(200);
      expect(contactEmailCheckPreview.parse(answer.json())).toMatchObject({
        contacts: 1,
        enabled: true,
      });
    },
  );

  let runs = 0;
  it.each(builtInRoles)(
    'refuses $scope $key exactly the commands its role lacks, naming each permission',
    async (role) => {
      const call = await signedInWith(role);
      const refused: string[] = [];

      for (const route of routes) {
        if (route.command === undefined) continue;
        const { name, permission } = route.command;
        const example = examples[name];
        if (example === undefined) throw new Error(`${name} needs an example.`);

        const answer = await example.run(call, ++runs);
        if (answer.statusCode === 403) {
          // Refused for the role, naming the permission. Or, for the agency's own work in a
          // business, where a business user always works, refused for where it ran, which
          // no role could change (1A review A1).
          const { detail, permission: named } = problem.parse(answer.json());
          expect(named === permission || detail === elsewhere, `${name}: ${answer.body}`).toBe(
            true,
          );
          refused.push(name);
        } else {
          expect(answer.statusCode, `${name}: ${answer.body}`).toBeLessThan(300);
        }
      }

      // A command two routes run (a new draft, by creating or importing) is tried through
      // each, and refused through each.
      const everyRoute = routes.flatMap(({ command }) =>
        command !== undefined && role.refuses.includes(command.name) ? [command.name] : [],
      );
      expect(refused.sort()).toEqual(everyRoute.sort());
      expect([...new Set(refused)]).toEqual([...role.refuses].sort());
    },
  );

  // The bell. Reading your own notifications, marking them read and choosing which kinds
  // you receive take no permission: none of its six routes runs a command, so the matrix
  // above never meets them. Every role does all of it, the viewer included.
  it.each(builtInRoles)(
    'lets $scope $key read and mark their own notifications and choose what they are told',
    async (role) => {
      const call = await signedInWith(role);
      const here = { inBusiness: true, payload: undefined };
      const notificationRoutes = routes.filter(
        ({ endpoint }) => endpoint.group === 'Notifications',
      );
      expect(notificationRoutes).toHaveLength(6);
      expect(notificationRoutes.filter(({ command }) => command !== undefined)).toEqual([]);
      // The three of them that change something are the whole of changesOnlyYourOwn: no
      // other endpoint is let through without a command under that name.
      expect(
        routes
          .filter(({ endpoint }) => Object.hasOwn(changesOnlyYourOwn, endpoint.operationId))
          .map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`)
          .sort(),
      ).toEqual([
        'post /notifications/read-all',
        'post /notifications/{id}/read',
        'put /notification-preferences',
      ]);
      // Two notifications for this person, written as the worker writes them.
      await database.as('crm_owner', (sql) =>
        sql.query(
          `insert into notifications.notifications
             (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind)
           select b.agency_id, b.id, $2, 'ai.limit_reached', 'matrix:' || n, 'system', 'ai_settings'
           from tenancy.businesses b, generate_series(1, 2) n where b.id = $1`,
          [matrixBusiness, matrixPerson],
        ),
      );

      const listed = await call('GET', '/notifications', here);
      expect(listed.statusCode, listed.body).toBe(200);
      const { items } = notificationList.parse(listed.json());
      expect(items).toHaveLength(2);
      const counted = await call('GET', '/notifications/unread-count', here);
      expect(counted.statusCode, counted.body).toBe(200);
      expect(unreadNotificationCount.parse(counted.json())).toEqual({ unread: 2, more: false });

      const one = await call('POST', `/notifications/${items[1]?.id ?? ''}/read`, here);
      expect(one.statusCode, one.body).toBe(200);
      const all = await call('POST', '/notifications/read-all', {
        inBusiness: true,
        payload: { through: items[0]?.id },
      });
      expect(all.statusCode, all.body).toBe(200);
      expect(unreadNotificationCount.parse(all.json())).toEqual({ unread: 0, more: false });

      const chosen = await call('PUT', '/notification-preferences', {
        inBusiness: true,
        payload: { items: [{ kind: 'message.received_other', inApp: false }] },
      });
      expect(chosen.statusCode, chosen.body).toBe(200);
      const read = await call('GET', '/notification-preferences', here);
      expect(read.statusCode, read.body).toBe(200);
      expect(
        notificationPreferences
          .parse(read.json())
          .items.filter((item) => !item.inApp)
          .map((item) => item.kind),
      ).toEqual(['message.received_other']);
    },
  );

  // What a screen reads to hide what a person cannot do. It is the role's own permissions
  // where the request works, and it enforces nothing: a command the answer leaves out is
  // refused by the command, as the matrix above shows for every one.
  it.each(builtInRoles)(
    'tells $scope $key exactly what its role allows here, and still refuses what that leaves out',
    async (role) => {
      const call = await signedInWith(role);
      const grant = { scope: role.scope, key: role.key, isBuiltin: true, permissions: [] };
      const places = role.scope === 'agency' ? ([true, false] as const) : ([true] as const);
      for (const inBusiness of places) {
        const answer = await call('GET', '/me/permissions', { inBusiness, payload: undefined });
        expect(answer.statusCode, answer.body).toBe(200);
        const told = myPermissions.parse(answer.json());
        expect(told.business).toBe(inBusiness ? toPublicId('business', matrixBusiness) : null);
        const allowed = permissionsOf(grant, inBusiness ? 'business' : 'agency');
        expect(told.permissions).toEqual(permissions.filter((key) => allowed.has(key)));
      }

      const here = await call('GET', '/me/permissions', { inBusiness: true, payload: undefined });
      const told = myPermissions.parse(here.json()).permissions;
      const attempt = await call('POST', '/custom-values', {
        inBusiness: true,
        payload: { name: `Told to ${role.scope} ${role.key}` },
      });
      if (told.includes('templates.manage')) {
        expect(attempt.statusCode, attempt.body).toBe(201);
      } else {
        expect(attempt.statusCode, attempt.body).toBe(403);
        expect(problem.parse(attempt.json()).permission).toBe('templates.manage');
      }
    },
  );
});
