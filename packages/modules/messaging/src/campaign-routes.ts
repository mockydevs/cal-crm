// The API of email campaigns. Reading a campaign, its audience, its checks and its results
// needs campaigns.manage, as writing one does: who is on a list and who unsubscribed is not
// for every signed-in person.
import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Route,
} from '@repo/commands';
import {
  cancelEmailCampaign,
  createEmailCampaign,
  createEmailCampaignFolder,
  deleteEmailCampaign,
  getEmailCampaign,
  getEmailCampaignAudience,
  getEmailCampaignChecks,
  getEmailCampaignSettings,
  getEmailCampaignStats,
  listEmailCampaignFolders,
  listEmailCampaignMailboxes,
  listEmailCampaignRecipients,
  listEmailCampaigns,
  moveEmailCampaign,
  parseInput,
  pauseEmailCampaign,
  removeEmailCampaignFolder,
  resumeEmailCampaign,
  scheduleEmailCampaign,
  sendEmailCampaign,
  sendEmailCampaignTest,
  updateEmailCampaign,
  updateEmailCampaignFolder,
  updateEmailCampaignSettings,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';

import { readAudiencePreview } from './campaign-audience.js';
import { readCampaignChecks } from './campaign-checks.js';
import { readCampaignRecipients, readCampaignStats } from './campaign-results.js';
import {
  audienceOf,
  mayManageCampaigns,
  requireCampaign,
  type CampaignOptions,
} from './campaign-store.js';
import { createCampaignTestCommand } from './campaign-tests.js';
import {
  createCampaignCommands,
  readCampaign,
  readCampaignMailboxes,
  readCampaigns,
  readCampaignSettings,
} from './campaigns.js';
import { createCampaignFolderCommands, readCampaignFolders } from './template-folders.js';

function requireManage(invocation: Invocation): void {
  requireBusiness(invocation.context);
  if (!mayManageCampaigns(invocation))
    throw new ForbiddenError(
      "Your role doesn't allow this: it needs campaigns.manage.",
      'campaigns.manage',
    );
}

export function createCampaignRoutes(options: CampaignOptions): readonly ApiRoute[] {
  const commands = createCampaignCommands(options);
  const folders = createCampaignFolderCommands();
  const test = createCampaignTestCommand(options);

  const list = {
    endpoint: listEmailCampaigns,
    run({ invocation, query }, { db }) {
      requireManage(invocation);
      const parsed = parseInput(listEmailCampaigns.query, query);
      return withTenant(db, invocation.context, (trx) => readCampaigns(trx, invocation, parsed));
    },
  } satisfies Route<typeof listEmailCampaigns>;
  const read = {
    endpoint: getEmailCampaign,
    run({ invocation, params }, { db }) {
      requireManage(invocation);
      const { id } = parseInput(getEmailCampaign.params, params);
      return withTenant(db, invocation.context, (trx) => readCampaign(trx, invocation, id));
    },
  } satisfies Route<typeof getEmailCampaign>;
  const create = {
    endpoint: createEmailCampaign,
    command: commands.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, commands.create, body, invocation),
  } satisfies Route<typeof createEmailCampaign>;
  const update = {
    endpoint: updateEmailCampaign,
    command: commands.update,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(updateEmailCampaign.params, params);
      return runCommand(
        services,
        commands.update,
        { ...parseInput(updateEmailCampaign.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof updateEmailCampaign>;
  const remove = {
    endpoint: deleteEmailCampaign,
    command: commands.remove,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(deleteEmailCampaign.params, params);
      return runCommand(
        services,
        commands.remove,
        { ...parseInput(deleteEmailCampaign.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof deleteEmailCampaign>;
  const move = {
    endpoint: moveEmailCampaign,
    command: commands.move,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(moveEmailCampaign.params, params);
      return runCommand(
        services,
        commands.move,
        { ...parseInput(moveEmailCampaign.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof moveEmailCampaign>;
  const audience = {
    endpoint: getEmailCampaignAudience,
    run({ invocation, params }, { db }) {
      requireManage(invocation);
      const { id } = parseInput(getEmailCampaignAudience.params, params);
      return withTenant(db, invocation.context, async (trx) => {
        const campaign = await requireCampaign(trx, invocation.context, id);
        return readAudiencePreview(trx, invocation, campaign, audienceOf(campaign), options);
      });
    },
  } satisfies Route<typeof getEmailCampaignAudience>;
  const checks = {
    endpoint: getEmailCampaignChecks,
    run({ invocation, params }, { db }) {
      requireManage(invocation);
      const { id } = parseInput(getEmailCampaignChecks.params, params);
      return withTenant(db, invocation.context, async (trx) =>
        readCampaignChecks(
          trx,
          invocation,
          await requireCampaign(trx, invocation.context, id),
          options,
        ),
      );
    },
  } satisfies Route<typeof getEmailCampaignChecks>;
  const sendTest = {
    endpoint: sendEmailCampaignTest,
    command: test,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(sendEmailCampaignTest.params, params);
      return runCommand(
        services,
        test,
        { ...parseInput(sendEmailCampaignTest.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof sendEmailCampaignTest>;
  const send = {
    endpoint: sendEmailCampaign,
    command: commands.send,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(sendEmailCampaign.params, params);
      return runCommand(
        services,
        commands.send,
        { ...parseInput(sendEmailCampaign.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof sendEmailCampaign>;
  const schedule = {
    endpoint: scheduleEmailCampaign,
    command: commands.schedule,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(scheduleEmailCampaign.params, params);
      return runCommand(
        services,
        commands.schedule,
        { ...parseInput(scheduleEmailCampaign.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof scheduleEmailCampaign>;
  const pause = {
    endpoint: pauseEmailCampaign,
    command: commands.pause,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        commands.pause,
        parseInput(pauseEmailCampaign.params, params),
        invocation,
      ),
  } satisfies Route<typeof pauseEmailCampaign>;
  const resume = {
    endpoint: resumeEmailCampaign,
    command: commands.resume,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        commands.resume,
        parseInput(resumeEmailCampaign.params, params),
        invocation,
      ),
  } satisfies Route<typeof resumeEmailCampaign>;
  const cancel = {
    endpoint: cancelEmailCampaign,
    command: commands.cancel,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        commands.cancel,
        parseInput(cancelEmailCampaign.params, params),
        invocation,
      ),
  } satisfies Route<typeof cancelEmailCampaign>;
  const recipients = {
    endpoint: listEmailCampaignRecipients,
    run({ invocation, params, query }, { db }) {
      requireManage(invocation);
      const { id } = parseInput(listEmailCampaignRecipients.params, params);
      const parsed = parseInput(listEmailCampaignRecipients.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readCampaignRecipients(trx, invocation, id, parsed),
      );
    },
  } satisfies Route<typeof listEmailCampaignRecipients>;
  const stats = {
    endpoint: getEmailCampaignStats,
    run({ invocation, params }, { db }) {
      requireManage(invocation);
      const { id } = parseInput(getEmailCampaignStats.params, params);
      return withTenant(db, invocation.context, (trx) => readCampaignStats(trx, invocation, id));
    },
  } satisfies Route<typeof getEmailCampaignStats>;
  const listFolders = {
    endpoint: listEmailCampaignFolders,
    run({ invocation }, { db }) {
      requireManage(invocation);
      return withTenant(db, invocation.context, (trx) => readCampaignFolders(trx, invocation));
    },
  } satisfies Route<typeof listEmailCampaignFolders>;
  const createFolder = {
    endpoint: createEmailCampaignFolder,
    command: folders.create,
    run: ({ invocation, body }, services) => runCommand(services, folders.create, body, invocation),
  } satisfies Route<typeof createEmailCampaignFolder>;
  const updateFolder = {
    endpoint: updateEmailCampaignFolder,
    command: folders.update,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(updateEmailCampaignFolder.params, params);
      return runCommand(
        services,
        folders.update,
        { ...parseInput(updateEmailCampaignFolder.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof updateEmailCampaignFolder>;
  const removeFolder = {
    endpoint: removeEmailCampaignFolder,
    command: folders.remove,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(removeEmailCampaignFolder.params, params);
      return runCommand(
        services,
        folders.remove,
        { ...parseInput(removeEmailCampaignFolder.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof removeEmailCampaignFolder>;
  // Choosing a campaign's mailbox is writing the campaign: campaigns.manage, not
  // mailboxes.manage, and nothing that signs in to or limits a mailbox.
  const mailboxes = {
    endpoint: listEmailCampaignMailboxes,
    run({ invocation }, { db }) {
      requireManage(invocation);
      return withTenant(db, invocation.context, (trx) => readCampaignMailboxes(trx, invocation));
    },
  } satisfies Route<typeof listEmailCampaignMailboxes>;
  const settings = {
    endpoint: getEmailCampaignSettings,
    run({ invocation }, { db }) {
      requireManage(invocation);
      return withTenant(db, invocation.context, (trx) =>
        readCampaignSettings(trx, invocation, options),
      );
    },
  } satisfies Route<typeof getEmailCampaignSettings>;
  const updateSettings = {
    endpoint: updateEmailCampaignSettings,
    command: commands.settings,
    run: ({ invocation, body }, services) =>
      runCommand(services, commands.settings, body, invocation),
  } satisfies Route<typeof updateEmailCampaignSettings>;

  return [
    list,
    read,
    create,
    update,
    remove,
    move,
    audience,
    checks,
    sendTest,
    send,
    schedule,
    pause,
    resume,
    cancel,
    recipients,
    stats,
    listFolders,
    createFolder,
    updateFolder,
    removeFolder,
    mailboxes,
    settings,
    updateSettings,
  ];
}
