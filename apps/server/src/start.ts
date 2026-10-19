// Starts what the configured role runs. app: the API and the dashboard. worker: background
// work, from Graphile Worker's queue. all: both, in one process. Every role answers
// /health and /ready, which Docker and Coolify use.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowEveryone, type AnyTask, type ApiRoute, type Services } from '@repo/commands';
import { connectDatabase } from '@repo/db';
import { createMailer, createMailboxConnector, type MailboxConnectorOptions } from '@repo/mail';
import {
  type AiGatewayOptions,
  createAiSettingsRoutes,
  createAssistantTurnTask,
  createDraftReplyTask,
  createExtractContactTask,
  createTestAiConnectionTask,
  readAiModelsIntegration,
} from '@repo/module-ai';
import { createAuthentication, readUserNames, type Authentication } from '@repo/module-auth';
import {
  createRemoveStripeEndpointsTask,
  createSetUpStripeTask,
  createStripeTransport,
} from '@repo/module-commerce';
import {
  completeGoogleConnect,
  createGoogleCalendarRoutes,
  createGoogleTransport,
  createGoogleWorker,
  createPublicBookingHandlers,
  freshenGoogleBusy,
  readGoogleCalendarIntegration,
  type AppointmentOptions,
  type GoogleSettings,
} from '@repo/module-calendar';
import { deliver, membersHolding } from '@repo/module-notifications';
import {
  acceptIntegrationWebhook,
  completeIntegrationConnect,
  createIntegrationRoutes,
  createIntegrationWorker,
  type IntegrationOptions,
  type IntegrationProvider,
} from '@repo/module-integrations';
import {
  assignOwnerFromBooking,
  createImportRoutes,
  findTimeZone,
  intakeContact,
  lockBookingContact,
  recordBookingTouch,
  setBookingContactTimezone,
  type ImportTaskOptions,
} from '@repo/module-crm';
import {
  lockActiveBusiness,
  readApiKeyNames,
  readAppsIntegration,
  readCalendarMemberMemberships,
  readPersonGrants,
  resolveCalendarMember,
} from '@repo/module-tenancy';
import {
  createFiles,
  createMedia,
  fileRoutes,
  mediaRoutes,
  publicMediaAddress,
  type Files,
} from '@repo/module-files';
import {
  createAltchaBotChallenge,
  createBookingShownProof,
  createFormRoutes,
  createPublicFormHandlers,
  createPublicTrackingHandlers,
  ownOrigin,
  readFormKeys,
} from '@repo/module-forms';
import {
  createPublicSiteHandlers,
  createSiteRoutes,
  loadPageScripts,
  pageScriptPaths,
} from '@repo/module-sites';
import {
  createMailboxRoutes,
  createSmsRoutes,
  createWebchatRoutes,
  createPublicWebchatHandlers,
  acceptSmsWebhook,
  openTriggerLink,
  createVerifyMailboxTask,
  createQueuedInstallMailer,
  createSendInstallMailTask,
  createCheckMailboxTask,
  createSyncMailboxTask,
  createTwilioTransport,
  resolveCalendarSender,
  readCalendarSenderChoices,
  readEligibleCalendarSenders,
  recordBookingNotificationConsent,
  recordBookingTextConsent,
  hasActiveSmsNumber,
  readCalendarConfirmationRecipient,
  queueCalendarConfirmation,
  smsDeliveryAvailable,
  createVoiceCallbackWorker,
  createPointVoiceNumbersTask,
  createFetchCallRecordingTask,
  createNumberTransport,
  readEmailableIntegration,
  readMailboxIntegration,
  readTwilioIntegration,
} from '@repo/module-messaging';
import { createSealingVault, createVault, type SealingVault, type Vault } from '@repo/module-vault';
import { localStorage, s3Storage, type Storage } from '@repo/storage';
import { pino, type Logger } from 'pino';
import {
  assistantConfirmations,
  assistantPage,
  deferredToolbox,
  draftSources,
  extractionSources,
  proposables,
} from './assistant.js';
import { campaignOptions, type CampaignInstall } from './campaign-options.js';
import { registeredPublicDocuments } from './commerce-public.js';
import type { OAuthTransport } from './oauth.js';
import { attachmentReader, commerceOptions, type CommerceInstall } from './commerce-options.js';
import type { Config, FilesConfig, VaultKeys } from './config.js';
import { announceFirstAdmin } from './first-admin.js';
import { loggerOptions } from './logger.js';
import { proxyTrustWarning } from './proxy-trust.js';
import { createPublicIntakeLimit, databaseAdmission } from './public-intake-limit.js';
import { SITE_SCRIPTS_PATH } from './public-sites.js';
import { logImportProgress } from './import-progress.js';
import { taskOptions } from './task-options.js';
import { API_PREFIX, buildServer } from './server.js';
import { createHostResolver } from './sites-dns.js';
import { loadWidgetScript } from './webchat-widget/transport.js';
import { loadEmbedScript } from './forms-embed/transport.js';
import { loadBookingEmbedScript } from './booking-embed.js';
import { loadTrackingScript } from './external-tracking.js';
import { createInstallAiGateway } from './worker/ai.js';
import { startWorker } from './worker/worker.js';
import { createMessagingDeliveryTasks, createVoiceTasks } from './worker/messaging-tasks.js';
import { createVoiceRelay } from './voice-relay.js';

export interface Running {
  /** Where the server listens, such as http://0.0.0.0:3000. */
  readonly address: string;
  /**
   * Settles when the worker has stopped (roles worker and all). Stopped by itself, the
   * process should exit, to be restarted. Never settles in the app role.
   */
  readonly ended: Promise<void>;
  /** Finishes the work in flight, within the configured timeout, and closes everything. */
  stop(): Promise<void>;
}

/** Where uploaded files' bytes go: a folder, or an S3-compatible bucket. */
function storageFor(settings: FilesConfig['storage'], logger: Logger): Storage {
  if (settings.kind === 'local') return localStorage({ directory: settings.directory });
  const { kind: _kind, ...s3 } = settings;
  return s3Storage({
    ...s3,
    log: (level, message) => {
      logger[level]({ source: 'storage' }, message);
    },
  });
}

/** The vault for the role's keys: the app's only seals, the worker's also opens. */
async function openVault(
  keys: VaultKeys,
): Promise<{ sealing: SealingVault; opening: Vault | undefined }> {
  if (keys.holds === 'public')
    return { sealing: await createSealingVault(keys.publicKey), opening: undefined };
  const opening = await createVault(keys.keys);
  return { sealing: opening, opening };
}

/**
 * Where the worker reaches the world outside the install. An install leaves all of it out:
 * public mail servers only, Twilio's own host, the system's DNS. No setting can change
 * any of it. The whole-product browser suite starts the same composition with its local
 * stand-ins (e2e/inbox-day-server.ts), since a test must never reach a real provider.
 */
export interface OutsideWorld {
  /** For every mailbox connection: a certificate authority and hosts of a local server. */
  readonly mailbox?: Pick<MailboxConnectorOptions, 'ca' | 'allowedPrivateHosts' | 'resolve'>;
  /** Sends the Twilio transport's requests; the transport still allows only its three. */
  readonly twilioFetch?: typeof fetch;
  /** Answers the DNS questions of a mailbox check, and of an email address check. */
  readonly resolveDns?: Parameters<typeof createCheckMailboxTask>[2];
  /**
   * Where Anthropic and OpenAI are, for the AI gateway. An install's keys go to those
   * providers' own addresses, which are constants; a stand-in's address must still be one
   * the transport may call, so a test also lists it in AI_LOCAL_SERVERS.
   */
  readonly aiBaseUrls?: AiGatewayOptions['baseUrls'];
  /**
   * Sends the requests to Google. The addresses asked for are always Google's own (a
   * constant list); a stand-in answers them in tests by being this fetch.
   */
  readonly googleFetch?: typeof fetch;
  /**
   * Providers Settings → Integrations can connect besides the install's own: a test's local
   * stand-in. An install has none; no setting adds one.
   */
  readonly integrationProviders?: readonly IntegrationProvider[];
}

export async function start(
  config: Config,
  routes:
    | readonly ApiRoute[]
    | ((
        authentication: Authentication | undefined,
        sealingVault: SealingVault | undefined,
        webhookDelivery: boolean,
        /** PUBLIC_URL: what the install can be reached at decides what it can offer. */
        publicUrl: string,
        /** What commerce prints, shares and sends with. */
        commerce: CommerceInstall,
        /** The install's ceiling on one agency's campaign emails. */
        campaigns: Pick<CampaignInstall, 'agencyDailyLimit'>,
        /** A fresh look at Google before the team books or moves, where set. */
        google: AppointmentOptions['google'],
      ) => readonly ApiRoute[]),
  tasks:
    | readonly AnyTask[]
    | ((
        vault: Vault | undefined,
        publicUrl: string,
        /** What an import's job needs: the files service, where this role has one. */
        imports: ImportTaskOptions,
        /** PUBLIC_INTAKE_SECRET: the key of a reminder's reschedule-or-cancel link. */
        linkSecret?: string,
        /** What a bulk action on contacts needs: the files service and the campaign ceiling. */
        contactBulk?: {
          readonly files?: Files | undefined;
          readonly agencyDailyLimit?: number | undefined;
        },
        /** What an email address check asks DNS through, where the world outside is given. */
        emailChecks?: { readonly resolve?: OutsideWorld['resolveDns'] },
      ) => readonly AnyTask[]),
  outside: OutsideWorld = {},
): Promise<Running> {
  const logger = pino(loggerOptions(config));
  // Behind a proxy it was not told to trust, every visitor would share one rate limit.
  const proxyWarning = proxyTrustWarning(config);
  if (proxyWarning !== undefined) logger.warn(proxyWarning);
  // Building the vault checks its keys, so a key that can't be used stops the start
  // rather than the first secret saved.
  const vault = config.vault === undefined ? undefined : await openVault(config.vault);
  if (config.systemMailbox !== undefined && vault === undefined)
    throw new Error('A selected system mailbox requires vault keys.');
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    maxConnections: config.databasePoolSize,
    // The pool has already dropped the failed connection; this only records it.
    onConnectionError: (error) => {
      logger.error({ err: error }, 'database connection failed');
    },
  });
  // Every signed-in actor may run every command until roles arrive.
  const services: Services = { db, authorize: allowEveryone };
  const serveApi = config.role !== 'worker';
  // The files service: uploads wait in the system's temporary folder. The roles that serve
  // the API always have it. The worker has it when it is given the same settings: an import
  // reads its file there and writes the rows it did not apply.
  const storage = config.files !== undefined ? storageFor(config.files.storage, logger) : undefined;
  const files =
    storage !== undefined && config.files !== undefined
      ? createFiles({
          storage,
          uploadDirectory: join(tmpdir(), 'crm-uploads'),
          maxBytes: config.files.maxBytes,
          linkSecret: config.files.linkSecret,
          businessQuotaBytes: config.files.businessQuotaBytes,
        })
      : undefined;
  // Media Storage: the library over the same files and the same storage. A file can be made
  // public only where the install answers public addresses at all.
  const media =
    storage !== undefined && config.files !== undefined && serveApi
      ? createMedia({
          storage,
          maxBytes: config.files.maxBytes,
          linkSecret: config.files.linkSecret,
          businessQuotaBytes: config.files.businessQuotaBytes,
          publicUrl: config.publicUrl,
          servesPublic: config.publicIntake !== undefined,
        })
      : undefined;
  const resolvedTasks =
    typeof tasks === 'function'
      ? tasks(
          vault?.opening,
          config.publicUrl,
          { files, onProgress: logImportProgress(logger) },
          config.appointmentLinkSecret,
          { files, agencyDailyLimit: config.campaignAgencyDailyLimit },
          outside.resolveDns === undefined ? {} : { resolve: outside.resolveDns },
        )
      : tasks;
  // Google Calendar for team members: the install's OAuth client, where it is set. The
  // redirect address is the one registered with Google, exactly.
  const google: GoogleSettings | undefined =
    config.google === undefined
      ? undefined
      : {
          client: {
            ...config.google,
            redirectUri: `${config.publicUrl}${API_PREFIX}/integrations/google/callback`,
          },
          transport: createGoogleTransport(outside.googleFetch),
        };
  const googleMembers = { memberships: readCalendarMemberMemberships };
  // A fresh look at the hosts' Google Calendars before a booking or a move, from the
  // booking page, the management link or the team.
  const googleFresh: AppointmentOptions['google'] =
    google === undefined
      ? undefined
      : {
          freshen: (context, calendarId, range) =>
            freshenGoogleBusy(db, context, calendarId, range),
        };
  // The worker's part: busy time, the booking's fresh look, events and revoking. Only a
  // role that opens secrets has it, as only it can use a refresh token.
  const googleWorker =
    google === undefined || vault?.opening === undefined
      ? undefined
      : createGoogleWorker({
          google,
          vault: vault.opening,
          members: googleMembers,
          random: Math.random,
          // The member is told in the bell; it opens their Connections page.
          notifyDisconnected: async (trx, context, notice) => {
            await deliver(trx, context, {
              kind: 'calendar.google_disconnected',
              recipients: [notice.userId],
              sourceKey: `calendar.google_disconnected:${notice.connectionId}:${String(Date.now())}`,
              collapseKey: `calendar.google_disconnected:${notice.connectionId}`,
              cause: { kind: 'system', id: null },
              subject: { kind: 'calendar_connections' },
              title: 'Google Calendar',
            });
          },
        });
  // Settings → Integrations. The providers this install's code can connect (none ships yet;
  // a test passes its stand-in), the connections that live on pages of their own read by
  // their modules, and where providers send the browser back and their updates.
  const integrationProviders = outside.integrationProviders ?? [];
  const integrationOptions: IntegrationOptions = {
    providers: integrationProviders,
    vault: vault?.sealing,
    redirectUri: (key) => `${config.publicUrl}${API_PREFIX}/integrations/${key}/callback`,
    elsewhere: [
      {
        key: 'google_calendar',
        available: google !== undefined && vault !== undefined,
        read: readGoogleCalendarIntegration,
      },
      { key: 'mailboxes', available: vault !== undefined, read: readMailboxIntegration },
      { key: 'emailable', available: vault !== undefined, read: readEmailableIntegration },
      { key: 'twilio', available: vault !== undefined, read: readTwilioIntegration },
      { key: 'ai_models', available: vault !== undefined, read: readAiModelsIntegration },
      { key: 'apps_and_api_keys', available: true, read: readAppsIntegration },
    ],
    webhooks:
      config.publicIntake === undefined
        ? undefined
        : { publicUrl: config.publicUrl, secret: config.publicIntake.secret },
    people: readUserNames,
  };
  // The worker's part: reading and checking accounts, refreshing tokens, revoking, and
  // verifying what providers sent. Only a role that opens secrets has it.
  const integrationWorker =
    vault?.opening === undefined
      ? undefined
      : createIntegrationWorker({
          providers: integrationProviders,
          vault: vault.opening,
          fetch,
          redirectUri: integrationOptions.redirectUri,
          random: Math.random,
          // Who connected it and whoever manages the business's integrations are told; the
          // notification opens Settings → Integrations.
          notifyAttention: async (trx, context, notice) => {
            const managers = await membersHolding(trx, context, ['integrations.manage']);
            await deliver(trx, context, {
              kind: 'integration.needs_attention',
              recipients: [notice.connectedBy, ...managers],
              sourceKey: `integration.needs_attention:${notice.connectionId}:${String(Date.now())}`,
              collapseKey: `integration.needs_attention:${notice.connectionId}`,
              cause: { kind: 'system', id: null },
              subject: { kind: 'integrations' },
              title: notice.provider,
            });
          },
        });
  const mailboxConnector = (timeoutMs?: number) =>
    createMailboxConnector({
      ...outside.mailbox,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  // The install's one AI gateway. Only a role that opens secrets has one: a provider's key
  // is sealed for the worker, and nothing else can call a model.
  const aiGateway =
    vault?.opening === undefined
      ? undefined
      : createInstallAiGateway({
          db,
          vault: vault.opening,
          logger,
          ...(config.aiLocalServers === undefined ? {} : { localServers: config.aiLocalServers }),
          ...(outside.aiBaseUrls === undefined ? {} : { baseUrls: outside.aiBaseUrls }),
        });
  // The Inbox as the draft job reads it and as its proposals run: with the vault this
  // role has, a text message can go out where the install has a public address.
  const workerInbox = {
    actorNames: taskOptions.actorNames,
    assignees: taskOptions.assignees,
    smsAvailable: smsDeliveryAvailable(config.publicUrl),
  };

  // The in-app assistant's tools are the routes composed further down, which in turn ask
  // whether there is a worker: so the worker is given a toolbox that is filled in then.
  const assistantTools = deferredToolbox(services, (operationId, error) => {
    logger.error({ source: 'ai', operationId, err: error }, 'assistant tool failed');
  });

  // What commerce prints, shares and sends with: the files service where this role has one,
  // and the secret every public surface of the install is keyed by.
  const commerce: CommerceInstall = {
    files,
    publicUrl: config.publicUrl,
    publicIntakeSecret: config.publicIntake?.secret,
  };

  // A worker role that can't reach its queue doesn't start, so that it's restarted.
  const worker =
    config.databaseWorkerUrl === undefined
      ? undefined
      : await startWorker({
          connectionString: config.databaseWorkerUrl,
          services,
          tasks:
            vault?.opening !== undefined && aiGateway !== undefined
              ? [
                  ...resolvedTasks,
                  ...(googleWorker?.tasks ?? []),
                  ...(integrationWorker?.tasks ?? []),
                  createVerifyMailboxTask(vault.opening, mailboxConnector()),
                  createSendInstallMailTask(vault.opening, mailboxConnector()),
                  createCheckMailboxTask(vault.opening, mailboxConnector(), outside.resolveDns),
                  createSyncMailboxTask(vault.opening, mailboxConnector(30_000)),
                  // "Test" in Settings → AI models: only this role can open a provider's key.
                  createTestAiConnectionTask(aiGateway),
                  // The inbox agent's reply drafts. The job writes a proposal and sends
                  // nothing; where the business lets the assistant act, it applies its own
                  // proposal through the command layer, which checks that rule itself.
                  createDraftReplyTask(aiGateway, {
                    registry: proposables(workerInbox),
                    actorNames: taskOptions.actorNames,
                    sources: draftSources(workerInbox),
                    // Ids and categories only: never a word of a thread or a draft.
                    onDraft: (event) => {
                      logger.info({ source: 'ai', ...event }, 'reply draft finished');
                    },
                  }),
                  // Field extraction and contact memory. The job reads what a contact wrote
                  // and stores proposals: it writes nothing to a contact itself, and
                  // applies its own proposals only where the business's rule says act,
                  // through the command layer. The in-app assistant's turns. Its tools are
                  // the API's own routes, run in this process as the assistant for the
                  // person who asked, with that person's permissions read again when the
                  // turn runs. A tool that would make something live is stored as a
                  // proposal instead.
                  createAssistantTurnTask(aiGateway, {
                    toolbox: assistantTools.toolbox,
                    proposables: proposables(workerInbox, config.publicUrl, true),
                    confirmations: assistantConfirmations,
                    grants: readPersonGrants,
                    page: assistantPage(config.publicUrl, true, workerInbox.smsAvailable),
                    // Ids, counts and categories only: never a word of a conversation.
                    onTurn: (event) => {
                      logger.info({ source: 'ai', ...event }, 'assistant turn finished');
                    },
                    onFault: (turnId, error) => {
                      logger.error({ source: 'ai', turnId, err: error }, 'assistant turn failed');
                    },
                  }),
                  createExtractContactTask(aiGateway, {
                    registry: proposables(workerInbox),
                    actorNames: taskOptions.actorNames,
                    sources: extractionSources(workerInbox),
                    // Ids, counts and categories only: never a word of a message or an answer.
                    onExtraction: (event) => {
                      logger.info({ source: 'ai', ...event }, 'extraction finished');
                    },
                  }),
                  ...createMessagingDeliveryTasks(
                    vault.opening,
                    createTwilioTransport(outside.twilioFetch),
                    mailboxConnector(),
                    db,
                    config.publicUrl,
                    // A message that carries a file (an invoice's PDF) is delivered only
                    // by a worker that has the files service.
                    files === undefined ? undefined : attachmentReader(files, services),
                    // Email campaigns: the task that releases them and the one that sends a
                    // test, with what the API's routes were given.
                    campaignOptions({
                      publicUrl: config.publicUrl,
                      agencyDailyLimit: config.campaignAgencyDailyLimit,
                    }),
                  ),
                  ...createVoiceTasks({
                    vault: vault.opening,
                    readGrants: readPersonGrants,
                    db,
                    publicUrl: config.publicUrl,
                    fetcher: outside.twilioFetch,
                  }),
                  createPointVoiceNumbersTask(
                    vault.opening,
                    createNumberTransport(
                      outside.twilioFetch === undefined ? {} : { fetcher: outside.twilioFetch },
                    ),
                    config.publicUrl,
                  ),
                  ...(files === undefined
                    ? []
                    : [
                        createFetchCallRecordingTask(vault.opening, files, {
                          fetcher: outside.twilioFetch,
                        }),
                      ]),
                  // Card payments: the webhook endpoint on each business's own Stripe account.
                  createSetUpStripeTask(vault.opening, createStripeTransport(), config.publicUrl),
                  createRemoveStripeEndpointsTask(vault.opening, createStripeTransport()),
                ]
              : resolvedTasks,
          ...(vault === undefined ? {} : { mailboxVault: vault.sealing, vault: vault.opening }),
          ...(files === undefined ? {} : { files }),
          ...(outside.twilioFetch === undefined ? {} : { twilioFetch: outside.twilioFetch }),
          commerce: commerceOptions(commerce),
          logger,
          shutdownTimeoutMs: config.shutdownTimeoutMs,
        }).catch(async (error: unknown) => {
          await db.destroy();
          throw error;
        });

  // The install's own mail: sign-in links and password resets.
  const mailer = !serveApi
    ? undefined
    : config.systemMailbox !== undefined && vault !== undefined
      ? createQueuedInstallMailer(services, vault.sealing, { mailboxId: config.systemMailbox })
      : config.mail === undefined
        ? undefined
        : createMailer({ url: config.mail.smtpUrl, from: config.mail.from });
  // Signing in, on its own crm_auth connections.
  const authentication =
    serveApi && config.authentication !== undefined && mailer !== undefined
      ? createAuthentication({
          connectionString: config.authentication.databaseUrl,
          secret: config.authentication.secret,
          publicUrl: config.publicUrl,
          signInLimit: config.signInLimit ?? true,
          onConnectionError: (error) => {
            logger.error({ err: error }, 'authentication database connection failed');
          },
          log: (level, message, ...details) => {
            logger[level]({ source: 'better-auth', details }, message);
          },
          sendMail: (email) => mailer.send(email),
        })
      : undefined;

  const resolvedRoutes =
    typeof routes === 'function'
      ? routes(
          authentication,
          vault?.sealing,
          worker !== undefined && vault?.opening !== undefined,
          config.publicUrl,
          commerce,
          { agencyDailyLimit: config.campaignAgencyDailyLimit },
          googleFresh,
        )
      : routes;
  // The small scripts a published page may load (a countdown that ticks, popups that open
  // by themselves), built with the renderer. Where they were not built pages name none.
  const siteScripts = config.publicIntake === undefined ? [] : loadPageScripts();
  if (config.publicIntake !== undefined && siteScripts.length === 0)
    logger.warn('The page scripts are not built: countdowns do not tick, popups open from a link.');
  const siteScriptPaths = pageScriptPaths(siteScripts, SITE_SCRIPTS_PATH);
  const configuredRoutes = [
    ...resolvedRoutes,
    ...(vault === undefined ? [] : createMailboxRoutes(vault.sealing)),
    ...(vault === undefined ? [] : createSmsRoutes(vault.sealing, config.publicUrl)),
    // Settings → AI models: the app seals a provider's key and can never open one.
    ...(vault === undefined
      ? []
      : createAiSettingsRoutes({
          vault: vault.sealing,
          localServers: config.aiLocalServers ?? [],
          people: readUserNames,
        })),
    ...createWebchatRoutes(config.publicUrl),
    // Settings → Calendars → Connections. The read always answers, so the dashboard knows
    // whether Google can be connected here at all.
    ...createGoogleCalendarRoutes({ google, vault: vault?.sealing, members: googleMembers }),
    // Settings → Integrations: every connection of the business, and those made there.
    ...createIntegrationRoutes(integrationOptions),
    // A link that previews a draft is keyed like the proof of when a form was shown. An
    // install without that secret serves no public form, and refuses a preview.
    ...createFormRoutes(config.publicUrl, { previewSecret: config.publicIntake?.secret }),
    // Funnels and websites. A share bundle is signed with a key of its own made from the
    // sign-in secret; without sign-in there is no secret, and no sharing. No sites address
    // is configured before the publishing phase, so a domain shows no record yet. A
    // published page answers on the install's own address (/s/<key>/…) where the install
    // serves public pages at all, which is with the public intake secret.
    ...createSiteRoutes({
      people: readUserNames,
      bundleSecret: config.authentication?.secret,
      resolve: createHostResolver(),
      publicUrl: config.publicIntake === undefined ? undefined : config.publicUrl,
      previewSecret: config.publicIntake?.secret,
      forms: readFormKeys,
      // A calendar on a page links to its booking page, which is there with the public API.
      booking: config.publicIntake !== undefined,
      scripts: siteScriptPaths,
    }),
    ...(files === undefined
      ? []
      : fileRoutes(files, { apiUrl: `${config.publicUrl}${API_PREFIX}` })),
    ...(media === undefined ? [] : mediaRoutes(media)),
    // Settings → Import data: a CSV file is uploaded through the files service above, then
    // looked at, previewed and imported from it.
    ...(files === undefined
      ? []
      : createImportRoutes({
          files,
          apiUrl: `${config.publicUrl}${API_PREFIX}`,
          actorNames: { user: readUserNames, api_key: readApiKeyNames },
        })),
  ];
  // The assistant's tools: every route this install serves, the registry choosing among
  // them (packages/contracts/src/assistant-tools.ts).
  assistantTools.ready(configuredRoutes);
  // One limiter for every public surface: it counts per address across all of them, and
  // bounds the database connections it may hold at once.
  const publicIntakeLimit =
    !serveApi || config.publicIntake === undefined
      ? undefined
      : createPublicIntakeLimit({
          admit: databaseAdmission(db),
          secret: config.publicIntake.secret,
          maxInFlight: Math.max(1, Math.min(8, config.databasePoolSize - 1)),
          onRefusal: (reason) => {
            logger.info({ reason }, 'Public intake refused');
          },
        });
  const publicBooking =
    publicIntakeLimit === undefined || config.publicIntake === undefined
      ? undefined
      : {
          handlers: createPublicBookingHandlers({
            db,
            publicOrigin: config.publicUrl,
            // The forms module's proof of when the page was shown, keyed by the same secret
            // on every instance.
            shown: createBookingShownProof(config.publicIntake.secret),
            // ALTCHA's proof of work for calendars that ask for it, keyed the same way.
            bot: createAltchaBotChallenge(config.publicIntake.secret),
            // The page's logo and cover, by the public addresses Media Storage gives them,
            // which this install answers: both are mounted with the same limiter.
            media: {
              publicAddress: (trx, fileId) => publicMediaAddress(trx, config.publicUrl, fileId),
            },
            // A fresh look at the hosts' Google Calendars before a booking.
            ...(googleFresh === undefined ? {} : { google: googleFresh }),
            calendars: {
              business: { lockActive: lockActiveBusiness },
              timeZones: { find: findTimeZone },
              members: {
                resolve: resolveCalendarMember,
                memberships: readCalendarMemberMemberships,
              },
              senders: {
                resolve: resolveCalendarSender,
                choices: readCalendarSenderChoices,
                eligible: readEligibleCalendarSenders,
              },
            },
            contacts: {
              lock: lockBookingContact,
              // A booking acts as the contact, which doesn't say how the contact came to be.
              intake: (trx, input, command) => intakeContact(trx, input, command, 'booking'),
              setTimezone: setBookingContactTimezone,
              attribute: recordBookingTouch,
              // A calendar's assignment setting, through the CRM's own owner command.
              assignOwner: assignOwnerFromBooking({
                actorNames: { user: readUserNames, api_key: readApiKeyNames },
                assignees: taskOptions.assignees,
              }),
            },
            notifications: {
              recipient: readCalendarConfirmationRecipient,
              recordConsent: recordBookingNotificationConsent,
              queue: queueCalendarConfirmation,
            },
            // "Text me reminders": offered where a text can reach the provider (a vault and
            // an address for delivery reports) and the business has a number that texts.
            texts: {
              available: async (trx) =>
                vault !== undefined &&
                smsDeliveryAvailable(config.publicUrl) &&
                (await hasActiveSmsNumber(trx)),
              recordConsent: recordBookingTextConsent,
            },
          }),
          rateLimit: publicIntakeLimit,
          // The script that sizes a booking page framed on a website; not built,
          // /calendars/embed.js answers 404 and the frame keeps the height its tag gives
          // it.
          script: loadBookingEmbedScript(),
        };
  if (publicBooking !== undefined && publicBooking.script === undefined)
    logger.warn('The booking embed is not built: /calendars/embed.js answers 404.');
  // Web chat. Without the built widget the API still answers and the script is a 404;
  // without the limiter's secret neither is mounted, as for public booking.
  const widgetScript = publicIntakeLimit === undefined ? undefined : loadWidgetScript();
  if (publicIntakeLimit !== undefined && widgetScript === undefined)
    logger.warn('The web chat widget is not built: /webchat/widget.js answers 404.');
  const publicWebchat =
    publicIntakeLimit === undefined
      ? undefined
      : {
          handlers: createPublicWebchatHandlers(db),
          rateLimit: publicIntakeLimit,
          script: widgetScript,
        };
  // Forms. As for web chat: without the built embed the API still answers and the script is
  // a 404; without the limiter's secret neither is mounted. The same secret keys the proof
  // of when a form was shown, so every app instance checks every other's.
  const publicIntake = publicIntakeLimit === undefined ? undefined : config.publicIntake;
  const embedScript = publicIntake === undefined ? undefined : loadEmbedScript();
  if (publicIntake !== undefined && embedScript === undefined)
    logger.warn('The form embed is not built: /forms/embed.js answers 404.');
  // The CRM's own address shows every published form on a page of its own (/f/<key>) and
  // a draft to whoever holds a preview link. It needs a secure address, or a developer's
  // own machine; without one, forms are shown on the websites they list and nowhere else.
  const formsOwnOrigin = publicIntake === undefined ? undefined : ownOrigin(config.publicUrl);
  if (publicIntake !== undefined && formsOwnOrigin === undefined)
    logger.warn('The public address is not secure: forms have no page of their own (/f/…).');
  const publicForms =
    publicIntakeLimit === undefined || publicIntake === undefined
      ? undefined
      : {
          handlers: createPublicFormHandlers({
            db,
            secret: publicIntake.secret,
            publicUrl: config.publicUrl,
            onDropped: (reason) => {
              logger.info({ reason }, 'Form submission dropped');
            },
          }),
          rateLimit: publicIntakeLimit,
          script: embedScript,
          ownOrigin: formsOwnOrigin,
        };
  // External Tracking: the script for a business's other websites and the address it reports
  // to. As forms: without the built script the API still answers and the script is a 404;
  // without the limiter's secret neither is mounted. The same secret keys the view tokens.
  const trackingScript = publicIntake === undefined ? undefined : loadTrackingScript();
  if (publicIntake !== undefined && trackingScript === undefined)
    logger.warn('The tracking script is not built: /tracking/external-tracking.js answers 404.');
  const publicTracking =
    publicIntakeLimit === undefined || publicIntake === undefined
      ? undefined
      : {
          handlers: createPublicTrackingHandlers({ db, secret: publicIntake.secret }),
          rateLimit: publicIntakeLimit,
          script: trackingScript,
        };
  // A quote's or an invoice's public page: /d/<token>. Mounted, like every public surface,
  // only with the limiter; its secret is also what the addresses are made with.
  const publicDocuments =
    publicIntakeLimit === undefined
      ? undefined
      : registeredPublicDocuments(db, commerceOptions(commerce), publicIntakeLimit);
  // A site's published pages (/s/<key>/<path>) and the preview of a draft. Mounted, like
  // every public surface, only with the limiter; its secret also keys the preview links.
  const publicSites =
    publicIntakeLimit === undefined || publicIntake === undefined
      ? undefined
      : {
          handlers: createPublicSiteHandlers({
            db,
            secret: publicIntake.secret,
            publicUrl: config.publicUrl,
            forms: readFormKeys,
            booking: true,
            scripts: siteScriptPaths,
            ...(config.sitesPageCachePages === undefined
              ? {}
              : { cache: { maxEntries: config.sitesPageCachePages } }),
          }),
          rateLimit: publicIntakeLimit,
          sharedCacheSeconds: config.sitesSharedCacheSeconds,
          scripts: siteScripts,
        };
  // OAuth for installed apps: the app trades codes and refresh tokens as crm_auth. Mounted,
  // like every public surface, only with the limiter.
  const oauth: OAuthTransport | undefined =
    authentication === undefined || publicIntakeLimit === undefined
      ? undefined
      : {
          issuer: config.publicUrl,
          token: (request) => authentication.oauthToken(request),
          revoke: (request) => authentication.oauthRevoke(request),
          rateLimit: publicIntakeLimit,
        };
  const server = await buildServer({
    config,
    logger,
    serveApi,
    routes: configuredRoutes,
    services,
    authentication,
    realtime: true,
    files,
    ...(publicBooking === undefined ? {} : { publicBooking }),
    ...(publicWebchat === undefined ? {} : { publicWebchat }),
    ...(publicForms === undefined ? {} : { publicForms }),
    ...(publicTracking === undefined ? {} : { publicTracking }),
    ...(publicDocuments === undefined ? {} : { publicDocuments }),
    ...(oauth === undefined ? {} : { oauth }),
    ...(publicSites === undefined ? {} : { publicSites }),
    ...(media === undefined ? {} : { publicMedia: { media, db, rateLimit: publicIntakeLimit } }),
    ...(serveApi ? { smsWebhooks: { accept: (request) => acceptSmsWebhook(db, request) } } : {}),
    ...(vault?.opening !== undefined
      ? {
          voiceWebhooks: createVoiceCallbackWorker(
            services,
            vault.opening,
            config.publicUrl,
            readPersonGrants,
          ),
        }
      : config.role === 'app' && config.voiceWorkerOrigin !== undefined
        ? {
            voiceWebhooks: { handle: createVoiceRelay({ workerOrigin: config.voiceWorkerOrigin }) },
          }
        : {}),
    // Google's redirect back after consent, where Google can be connected.
    ...(serveApi && google !== undefined && vault !== undefined
      ? {
          googleCallback: {
            complete: (callback, person, correlationId) =>
              completeGoogleConnect(
                { google, vault: vault.sealing, members: googleMembers },
                services,
                callback,
                person,
                correlationId,
              ),
          },
        }
      : {}),
    // A provider's redirect back after consent, and its updates for a connection.
    ...(serveApi && vault !== undefined
      ? {
          integrationCallback: {
            complete: (key, callback, person, correlationId) =>
              completeIntegrationConnect(
                integrationOptions,
                services,
                fetch,
                key,
                callback,
                person,
                correlationId,
              ),
          },
        }
      : {}),
    ...(serveApi
      ? {
          integrationWebhooks: {
            accept: (request) => acceptIntegrationWebhook(db, integrationProviders, request),
          },
        }
      : {}),
    // A trigger link's public address. The shared limiter guards it where the install has
    // one; the click itself is bounded either way.
    ...(serveApi
      ? {
          triggerLinks: {
            open: (token: string, requestId: string) => openTriggerLink(db, token, requestId),
            rateLimit: publicIntakeLimit,
          },
        }
      : {}),
    readinessChecks: {
      database: async () => {
        await db.selectNoFrom((eb) => eb.val(1).as('ok')).execute();
      },
    },
  });

  const address = await server.app.listen({ host: config.host, port: config.port });
  server.app.log.info({ role: config.role, address }, 'started');
  // While nobody runs the agency, a setup link for the first admin.
  const announced =
    authentication === undefined ? undefined : announceFirstAdmin(authentication, logger);

  return {
    address,
    ended: worker?.ended ?? new Promise(() => undefined),
    async stop() {
      server.app.log.info({ role: config.role }, 'stopping');
      await Promise.all([server.close(config.shutdownTimeoutMs), worker?.stop(), announced]);
      // Mail still being sent goes first, then the connections it needs.
      await Promise.all([db.destroy(), authentication?.close(), storage?.close()]);
      mailer?.close();
    },
  };
}
