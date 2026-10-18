import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createMessageTemplateFolder,
  getMessageTemplateFolder,
  listMessageTemplateFolders,
  moveMessageTemplate,
  parseInput,
  removeMessageTemplateFolder,
  updateMessageTemplateFolder,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { createTemplateCommands, type TemplateOptions } from './message-templates.js';
import {
  createTemplateFolderCommands,
  readTemplateFolder,
  readTemplateFolders,
} from './template-folders.js';

/** The library and workflow picker share the same tenant-scoped template assets. */
export function createTemplateFolderRoutes(options: TemplateOptions = {}): readonly ApiRoute[] {
  const commands = createTemplateFolderCommands();
  const templates = createTemplateCommands(options);
  const list = {
    endpoint: listMessageTemplateFolders,
    run({ invocation }, { db }) {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, (trx) => readTemplateFolders(trx, invocation));
    },
  } satisfies Route<typeof listMessageTemplateFolders>;
  const read = {
    endpoint: getMessageTemplateFolder,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(getMessageTemplateFolder.params, params);
      return withTenant(db, invocation.context, (trx) => readTemplateFolder(trx, invocation, id));
    },
  } satisfies Route<typeof getMessageTemplateFolder>;
  const create = {
    endpoint: createMessageTemplateFolder,
    command: commands.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, commands.create, body, invocation),
  } satisfies Route<typeof createMessageTemplateFolder>;
  const update = {
    endpoint: updateMessageTemplateFolder,
    command: commands.update,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(updateMessageTemplateFolder.params, params);
      return runCommand(
        services,
        commands.update,
        { ...parseInput(updateMessageTemplateFolder.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof updateMessageTemplateFolder>;
  const remove = {
    endpoint: removeMessageTemplateFolder,
    command: commands.remove,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(removeMessageTemplateFolder.params, params);
      return runCommand(
        services,
        commands.remove,
        { ...parseInput(removeMessageTemplateFolder.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof removeMessageTemplateFolder>;
  const move = {
    endpoint: moveMessageTemplate,
    command: templates.move,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(moveMessageTemplate.params, params);
      return runCommand(
        services,
        templates.move,
        { ...parseInput(moveMessageTemplate.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof moveMessageTemplate>;
  return [list, read, create, update, remove, move];
}
