// The automation API's routes (AUTOMATIONS.md section 5). Reads are open to anyone in the
// business, as other reads are; changing and checking drafts needs automations.manage. The
// server passes in tenancy's reader of the people automations can assign or notify.
import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Route,
} from '@repo/commands';
import {
  AUTOMATION_EXPORT_FORMAT,
  automationCatalog,
  automationCatalogResponse,
  automationJsonSchema,
  continueAutomationRun,
  createAutomation,
  deleteAutomationWebhookSecret,
  copyWorkflowEmailTemplate,
  createAutomationFolder,
  createAutomationTestRun,
  deleteAutomation,
  deleteAutomationFolder,
  diffAutomationVersions,
  enableWorkflowEmailSync,
  explainAutomationContact,
  exportAutomation,
  getAutomation,
  getAutomationCatalog,
  getAutomationRun,
  getAutomationSchema,
  getAutomationStats,
  getAutomationTestRun,
  getAutomationVersion,
  getAutomationWebhookSigning,
  getWorkflowEmailStepStatistics,
  importAutomation,
  leadSources,
  listAutomationFolders,
  listAutomationRuns,
  listAutomations,
  listAutomationStepRuns,
  listAutomationTriggerEvaluations,
  listAutomationVersions,
  listAutomationWebhookSecrets,
  listRecordAutomationRuns,
  listTemplateWorkflowActions,
  retryAutomationRun,
  moveAutomation,
  parseInput,
  patchAutomationDraft,
  pauseAutomation,
  portableAutomation,
  publishAutomation,
  putAutomationWebhookSecret,
  replaceAutomationDraft,
  restoreAutomation,
  resumeAutomation,
  rotateAutomationWebhookSecret,
  saveSyncedWorkflowEmail,
  updateAutomationFolder,
  validateAutomation,
  validateAutomationDocument,
  type Permission,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ConflictError, NotFoundError } from '@repo/kernel';
import type { TaskOptions } from '@repo/module-crm';
import { createTemplateCommands } from '@repo/module-messaging';

import {
  checkedDocument,
  createDraftCommands,
  readAutomation,
  readAutomations,
  validationOf,
  type ReadSetup,
} from './drafts.js';
import { createDeletionCommands } from './deletion.js';
import { readEmailStepStatistics } from './email-step-statistics.js';
import { createEmailSyncCommands } from './email-sync.js';
import { readTemplateWorkflowActions } from './email-template-actions.js';
import { createEmailTemplateCopyCommand } from './email-template-copy.js';
import { createFolderCommands, readFolders } from './folders.js';
import {
  diffVersions,
  readRecordRuns,
  readRun,
  readRuns,
  readStepRuns,
  readVersion,
  readVersions,
} from './history.js';
import { createLifecycleCommands } from './lifecycle.js';
import { readAutomationSetup, type ReadAutomationUsers } from './setup.js';
import { readAutomationStats } from './stats.js';
import { readTemplateFields, readTemplateUses } from './template-uses.js';
import { createContinueRunCommand } from './run-continue.js';
import { retryRunCommand } from './run-retry.js';
import { readTestRun, testRunCommand } from './test-runs.js';
import { explainContact, readTriggerEvaluations } from './trigger-evaluations.js';
import {
  createWebhookSecretCommands,
  readWebhookSecrets,
  type WebhookSecretVault,
} from './webhook-secrets.js';
import {
  createRotateWebhookSecretCommand,
  readWebhookSigningStatus,
  type LockBusiness,
  type SecretSealer,
} from './webhook-signing.js';

// What the caller's role allows, for screens to offer or hide an action. The commands
// check the same permissions themselves; this only saves a refused attempt.
const allows = (invocation: Invocation, permission: Permission): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has(permission);

export function createAutomationRoutes({
  users,
  signing: sealing,
  webhookSecrets: secretsVault,
  webhookDelivery,
  smsDelivery = false,
  teamNotifications = false,
  actorNames,
}: {
  users: ReadAutomationUsers;
  /**
   * How people are named, as the CRM's timeline names them: a run's history then says who
   * continued it. Left out, it says what kind of actor did.
   */
  actorNames?: TaskOptions['actorNames'] | undefined;
  /**
   * What making a webhook signing secret needs: the app's vault, which seals a secret and
   * can't read it back, and tenancy's lock on the caller's active business. An install with
   * no vault leaves it out, and can't make a secret.
   */
  signing?: { readonly vault: SecretSealer; readonly lockBusiness: LockBusiness } | undefined;
  /**
   * What storing a webhook header's secret needs: the app's vault, which seals, replaces
   * and removes a secret but can't read it, and the same lock. Left out, none can be stored.
   */
  webhookSecrets?:
    { readonly vault: WebhookSecretVault; readonly lockBusiness: LockBusiness } | undefined;
  /** Whether this install's worker can open secrets, and so sign and send webhooks. */
  webhookDelivery: boolean;
  /**
   * Whether this install can send a text message at all: a vault, and a public address
   * the provider can report delivery to. Without it no business is offered the channel.
   */
  smsDelivery?: boolean | undefined;
  teamNotifications?: boolean | undefined;
}): readonly ApiRoute[] {
  const setup: ReadSetup = (trx, context) =>
    readAutomationSetup(trx, context, users, { webhookDelivery, smsDelivery, teamNotifications });
  const drafts = createDraftCommands({ setup });
  const lifecycle = createLifecycleCommands({ setup });
  const copyEmail = createEmailTemplateCopyCommand({ setup });
  // A synced edit is messaging's own template edit, answered as its routes answer it.
  const emailSync = createEmailSyncCommands({
    setup,
    templates: createTemplateCommands({ uses: readTemplateUses, fields: readTemplateFields }),
  });
  const folderCommands = createFolderCommands();
  const deletion = createDeletionCommands();
  const rotateSecret =
    sealing === undefined ? undefined : createRotateWebhookSecretCommand(sealing);
  const headerSecrets =
    secretsVault === undefined ? undefined : createWebhookSecretCommands(secretsVault);

  const schema = {
    endpoint: getAutomationSchema,
    run: () => Promise.resolve(automationJsonSchema()),
  } satisfies Route<typeof getAutomationSchema>;

  const catalog = {
    endpoint: getAutomationCatalog,
    run({ invocation }, { db }) {
      requireBusiness(invocation.context);
      const catalogue = automationCatalog();
      return withTenant(db, invocation.context, async (trx) =>
        automationCatalogResponse.parse({
          ...catalogue,
          // The built-in lead source names, so a condition on a lead source can be written
          // without guessing one: the leaf "source" holds one of them, or the text an
          // address carried in source=.
          attribution: { ...catalogue.attribution, sources: leadSources },
          setup: await setup(trx, invocation.context),
        }),
      );
    },
  } satisfies Route<typeof getAutomationCatalog>;

  const list = {
    endpoint: listAutomations,
    run({ invocation, query }, { db }) {
      requireBusiness(invocation.context);
      const parsed = parseInput(listAutomations.query, query);
      return withTenant(db, invocation.context, async (trx) => ({
        ...(await readAutomations(trx, parsed)),
        canManage: allows(invocation, 'automations.manage'),
      }));
    },
  } satisfies Route<typeof listAutomations>;

  const read = {
    endpoint: getAutomation,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(getAutomation.params, params);
      return withTenant(db, invocation.context, async (trx) => ({
        ...(await readAutomation(trx, id)),
        canManage: allows(invocation, 'automations.manage'),
        canPublish: allows(invocation, 'automations.publish'),
      }));
    },
  } satisfies Route<typeof getAutomation>;

  const create = {
    endpoint: createAutomation,
    command: drafts.create,
    run: ({ invocation, body }, services) => runCommand(services, drafts.create, body, invocation),
  } satisfies Route<typeof createAutomation>;

  const replace = {
    endpoint: replaceAutomationDraft,
    command: drafts.replace,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        drafts.replace,
        {
          ...parseInput(replaceAutomationDraft.body, body),
          id: parseInput(replaceAutomationDraft.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof replaceAutomationDraft>;

  const patch = {
    endpoint: patchAutomationDraft,
    command: drafts.patch,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        drafts.patch,
        {
          ...parseInput(patchAutomationDraft.body, body),
          id: parseInput(patchAutomationDraft.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof patchAutomationDraft>;

  const copyEmailTemplate = {
    endpoint: copyWorkflowEmailTemplate,
    command: copyEmail,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        copyEmail,
        {
          ...parseInput(copyWorkflowEmailTemplate.body, body),
          id: parseInput(copyWorkflowEmailTemplate.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof copyWorkflowEmailTemplate>;

  const enableEmailSync = {
    endpoint: enableWorkflowEmailSync,
    command: emailSync.enable,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        emailSync.enable,
        {
          ...parseInput(enableWorkflowEmailSync.body, body),
          id: parseInput(enableWorkflowEmailSync.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof enableWorkflowEmailSync>;

  const saveSyncedEmail = {
    endpoint: saveSyncedWorkflowEmail,
    command: emailSync.save,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        emailSync.save,
        {
          ...parseInput(saveSyncedWorkflowEmail.body, body),
          id: parseInput(saveSyncedWorkflowEmail.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof saveSyncedWorkflowEmail>;

  // Which workflow actions use a template: read as templates and automations are.
  const templateActions = {
    endpoint: listTemplateWorkflowActions,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(listTemplateWorkflowActions.params, params);
      const parsed = parseInput(listTemplateWorkflowActions.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readTemplateWorkflowActions(trx, invocation, id, parsed),
      );
    },
  } satisfies Route<typeof listTemplateWorkflowActions>;

  const emailStatistics = {
    endpoint: getWorkflowEmailStepStatistics,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id, step } = parseInput(getWorkflowEmailStepStatistics.params, params);
      const range = parseInput(getWorkflowEmailStepStatistics.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readEmailStepStatistics(trx, id, step, range),
      );
    },
  } satisfies Route<typeof getWorkflowEmailStepStatistics>;
  const validate = {
    endpoint: validateAutomationDocument,
    async run({ invocation, body }, services) {
      await requirePermission(
        services,
        { name: 'automation.validate', permission: 'automations.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      const document = checkedDocument(
        parseInput(validateAutomationDocument.body, body).document,
        '/document',
      );
      return withTenant(services.db, invocation.context, async (trx) =>
        validationOf(validateAutomation(document, await setup(trx, invocation.context))),
      );
    },
  } satisfies Route<typeof validateAutomationDocument>;

  const publish = {
    endpoint: publishAutomation,
    command: lifecycle.publish,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        lifecycle.publish,
        {
          ...parseInput(publishAutomation.body, body),
          id: parseInput(publishAutomation.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof publishAutomation>;

  const pause = {
    endpoint: pauseAutomation,
    command: lifecycle.pause,
    run: ({ invocation, params }, services) =>
      runCommand(services, lifecycle.pause, parseInput(pauseAutomation.params, params), invocation),
  } satisfies Route<typeof pauseAutomation>;

  const resume = {
    endpoint: resumeAutomation,
    command: lifecycle.resume,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        lifecycle.resume,
        parseInput(resumeAutomation.params, params),
        invocation,
      ),
  } satisfies Route<typeof resumeAutomation>;

  const versions = {
    endpoint: listAutomationVersions,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(listAutomationVersions.params, params);
      const parsed = parseInput(listAutomationVersions.query, query);
      return withTenant(db, invocation.context, (trx) => readVersions(trx, id, parsed));
    },
  } satisfies Route<typeof listAutomationVersions>;

  const version = {
    endpoint: getAutomationVersion,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const parsed = parseInput(getAutomationVersion.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readVersion(trx, parsed.id, parsed.version),
      );
    },
  } satisfies Route<typeof getAutomationVersion>;

  const diff = {
    endpoint: diffAutomationVersions,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const parsed = parseInput(diffAutomationVersions.params, params);
      return withTenant(db, invocation.context, (trx) =>
        diffVersions(trx, parsed.id, parsed.from, parsed.to),
      );
    },
  } satisfies Route<typeof diffAutomationVersions>;

  const test = {
    endpoint: createAutomationTestRun,
    command: testRunCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        testRunCommand,
        {
          ...parseInput(createAutomationTestRun.body, body),
          id: parseInput(createAutomationTestRun.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof createAutomationTestRun>;

  const testRun = {
    endpoint: getAutomationTestRun,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'automation.read_test_run', permission: 'automations.manage' },
        invocation,
      );
      requireBusiness(invocation.context);
      const parsed = parseInput(getAutomationTestRun.params, params);
      return withTenant(services.db, invocation.context, (trx) =>
        readTestRun(trx, parsed.id, parsed.runId),
      );
    },
  } satisfies Route<typeof getAutomationTestRun>;

  const runs = {
    endpoint: listAutomationRuns,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(listAutomationRuns.params, params);
      const parsed = parseInput(listAutomationRuns.query, query);
      return withTenant(db, invocation.context, (trx) => readRuns(trx, id, parsed));
    },
  } satisfies Route<typeof listAutomationRuns>;

  const run = {
    endpoint: getAutomationRun,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const { runId } = parseInput(getAutomationRun.params, params);
      return withTenant(db, invocation.context, (trx) => readRun(trx, runId));
    },
  } satisfies Route<typeof getAutomationRun>;

  // A failed run, run again from the step it failed at (run-retry.ts).
  const retryRun = {
    endpoint: retryAutomationRun,
    command: retryRunCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        retryRunCommand,
        parseInput(retryAutomationRun.params, params),
        invocation,
      ),
  } satisfies Route<typeof retryAutomationRun>;

  // A waiting run's wait ended now, by a person (run-continue.ts).
  const continueRunCommand = createContinueRunCommand({ actorNames });
  const continueRun = {
    endpoint: continueAutomationRun,
    command: continueRunCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        continueRunCommand,
        {
          ...parseInput(continueAutomationRun.body, body),
          runId: parseInput(continueAutomationRun.params, params).runId,
        },
        invocation,
      ),
  } satisfies Route<typeof continueAutomationRun>;

  const recordRuns = {
    endpoint: listRecordAutomationRuns,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(listRecordAutomationRuns.params, params);
      const parsed = parseInput(listRecordAutomationRuns.query, query);
      return withTenant(db, invocation.context, (trx) => readRecordRuns(trx, id, parsed));
    },
  } satisfies Route<typeof listRecordAutomationRuns>;

  const stepRuns = {
    endpoint: listAutomationStepRuns,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(listAutomationStepRuns.params, params);
      const parsed = parseInput(listAutomationStepRuns.query, query);
      return withTenant(db, invocation.context, (trx) => readStepRuns(trx, id, parsed));
    },
  } satisfies Route<typeof listAutomationStepRuns>;

  const stats = {
    endpoint: getAutomationStats,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(getAutomationStats.params, params);
      return withTenant(db, invocation.context, (trx) => readAutomationStats(trx, id));
    },
  } satisfies Route<typeof getAutomationStats>;

  // Why the automation did not start: each time an event it listens for came and it
  // enrolled nobody, and the same for one contact beside its runs.
  const triggerEvaluations = {
    endpoint: listAutomationTriggerEvaluations,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(listAutomationTriggerEvaluations.params, params);
      const parsed = parseInput(listAutomationTriggerEvaluations.query, query);
      return withTenant(db, invocation.context, (trx) => readTriggerEvaluations(trx, id, parsed));
    },
  } satisfies Route<typeof listAutomationTriggerEvaluations>;

  const explain = {
    endpoint: explainAutomationContact,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(explainAutomationContact.params, params);
      const { contactId } = parseInput(explainAutomationContact.query, query);
      return withTenant(db, invocation.context, (trx) => explainContact(trx, id, contactId));
    },
  } satisfies Route<typeof explainAutomationContact>;

  const folders = {
    endpoint: listAutomationFolders,
    run({ invocation }, { db }) {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, async (trx) => ({
        ...(await readFolders(trx)),
        canManage: allows(invocation, 'automations.manage'),
      }));
    },
  } satisfies Route<typeof listAutomationFolders>;

  const createFolder = {
    endpoint: createAutomationFolder,
    command: folderCommands.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, folderCommands.create, body, invocation),
  } satisfies Route<typeof createAutomationFolder>;

  const updateFolder = {
    endpoint: updateAutomationFolder,
    command: folderCommands.update,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        folderCommands.update,
        {
          ...parseInput(updateAutomationFolder.body, body),
          id: parseInput(updateAutomationFolder.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof updateAutomationFolder>;

  const deleteFolder = {
    endpoint: deleteAutomationFolder,
    command: folderCommands.remove,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        folderCommands.remove,
        parseInput(deleteAutomationFolder.params, params),
        invocation,
      ),
  } satisfies Route<typeof deleteAutomationFolder>;

  const move = {
    endpoint: moveAutomation,
    command: folderCommands.moveAutomation,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        folderCommands.moveAutomation,
        {
          ...parseInput(moveAutomation.body, body),
          id: parseInput(moveAutomation.params, params).id,
        },
        invocation,
      ),
  } satisfies Route<typeof moveAutomation>;

  const remove = {
    endpoint: deleteAutomation,
    command: deletion.remove,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        deletion.remove,
        parseInput(deleteAutomation.params, params),
        invocation,
      ),
  } satisfies Route<typeof deleteAutomation>;

  const restore = {
    endpoint: restoreAutomation,
    command: deletion.restore,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        deletion.restore,
        parseInput(restoreAutomation.params, params),
        invocation,
      ),
  } satisfies Route<typeof restoreAutomation>;

  const exported = {
    endpoint: exportAutomation,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(exportAutomation.params, params);
      const { source } = parseInput(exportAutomation.query, query);
      return withTenant(db, invocation.context, async (trx) => {
        const automation = await readAutomation(trx, id);
        const written = source === 'live' ? automation.live?.document : automation.draft;
        if (written === undefined) throw new NotFoundError('automation_version', id);
        const { document, warnings } = portableAutomation(
          written,
          await setup(trx, invocation.context),
        );
        return {
          format: AUTOMATION_EXPORT_FORMAT,
          formatVersion: 1 as const,
          exportedAt: new Date().toISOString(),
          document,
          warnings: warnings.map((warning) => ({ ...warning })),
        };
      });
    },
  } satisfies Route<typeof exportAutomation>;

  // An import is a new draft like any other: never live, and validated against this business.
  const imported = {
    endpoint: importAutomation,
    command: drafts.create,
    run: ({ invocation, body }, services) =>
      runCommand(
        services,
        drafts.create,
        { document: parseInput(importAutomation.body, body).document },
        invocation,
      ),
  } satisfies Route<typeof importAutomation>;

  const signing = {
    endpoint: getAutomationWebhookSigning,
    run({ invocation }, { db }) {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, readWebhookSigningStatus);
    },
  } satisfies Route<typeof getAutomationWebhookSigning>;

  // The answer holds the new secret: the server must send it uncached, and log none of it.
  const rotate =
    rotateSecret === undefined
      ? ({
          endpoint: rotateAutomationWebhookSecret,
          // Refused the same for everyone allowed to ask: there is nowhere to keep a secret.
          async run({ invocation }, services) {
            await requirePermission(
              services,
              { name: 'automation.rotate_webhook_secret', permission: 'automations.publish' },
              invocation,
            );
            throw new ConflictError(
              "This install has no secrets vault, so a signing secret can't be made or kept.",
            );
          },
        } satisfies Route<typeof rotateAutomationWebhookSecret>)
      : ({
          endpoint: rotateAutomationWebhookSecret,
          command: rotateSecret,
          run: ({ invocation }, services) => runCommand(services, rotateSecret, {}, invocation),
        } satisfies Route<typeof rotateAutomationWebhookSecret>);

  const listSecrets = {
    endpoint: listAutomationWebhookSecrets,
    run({ invocation }, { db }) {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, readWebhookSecrets);
    },
  } satisfies Route<typeof listAutomationWebhookSecrets>;

  // Refused the same for everyone allowed to ask, on an install with nowhere to keep one.
  const noVault = async (
    invocation: Invocation,
    services: Parameters<typeof requirePermission>[0],
    name: string,
  ): Promise<never> => {
    await requirePermission(services, { name, permission: 'automations.publish' }, invocation);
    throw new ConflictError("This install has no secrets vault, so a secret can't be kept.");
  };

  // The request holds the value: the server logs none of it, and the answer never has it.
  const putSecret =
    headerSecrets === undefined
      ? ({
          endpoint: putAutomationWebhookSecret,
          run: ({ invocation }, services) =>
            noVault(invocation, services, 'automation.put_webhook_secret'),
        } satisfies Route<typeof putAutomationWebhookSecret>)
      : ({
          endpoint: putAutomationWebhookSecret,
          command: headerSecrets.put,
          run: ({ invocation, params, body }, services) =>
            runCommand(
              services,
              headerSecrets.put,
              {
                ...parseInput(putAutomationWebhookSecret.params, params),
                ...parseInput(putAutomationWebhookSecret.body, body),
              },
              invocation,
            ),
        } satisfies Route<typeof putAutomationWebhookSecret>);

  const deleteSecret =
    headerSecrets === undefined
      ? ({
          endpoint: deleteAutomationWebhookSecret,
          run: ({ invocation }, services) =>
            noVault(invocation, services, 'automation.delete_webhook_secret'),
        } satisfies Route<typeof deleteAutomationWebhookSecret>)
      : ({
          endpoint: deleteAutomationWebhookSecret,
          command: headerSecrets.remove,
          run: ({ invocation, params }, services) =>
            runCommand(
              services,
              headerSecrets.remove,
              parseInput(deleteAutomationWebhookSecret.params, params),
              invocation,
            ),
        } satisfies Route<typeof deleteAutomationWebhookSecret>);

  return [
    signing,
    rotate,
    listSecrets,
    putSecret,
    deleteSecret,
    exported,
    imported,
    schema,
    catalog,
    list,
    validate,
    read,
    create,
    replace,
    patch,
    copyEmailTemplate,
    enableEmailSync,
    saveSyncedEmail,
    templateActions,
    emailStatistics,
    publish,
    pause,
    resume,
    versions,
    version,
    diff,
    test,
    testRun,
    runs,
    run,
    retryRun,
    continueRun,
    recordRuns,
    folders,
    createFolder,
    updateFolder,
    deleteFolder,
    move,
    remove,
    restore,
    stats,
    stepRuns,
    triggerEvaluations,
    explain,
  ];
}
