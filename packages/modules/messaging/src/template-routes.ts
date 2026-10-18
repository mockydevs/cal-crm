import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  archiveMessageTemplate,
  bulkMessageTemplates,
  createMessageTemplate,
  deleteMessageTemplate,
  duplicateMessageTemplate,
  getMessageTemplate,
  listMessageTemplates,
  parseInput,
  previewMessageTemplate,
  previewMessageTemplateInput,
  previewMessageTemplateText,
  renderEmailPreview,
  renderEmailPreviewInput,
  restoreMessageTemplate,
  updateMessageTemplate,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { createTemplateFolderRoutes } from './template-folder-routes.js';
import {
  createTemplateCommands,
  readTemplate,
  readTemplates,
  type TemplateOptions,
} from './message-templates.js';
import { readEmailPreview, type PreviewOptions } from './template-preview.js';

/**
 * Message templates. Reading needs no permission beyond being in the business, as
 * reading its automations does; each answer says whether the reader may change it.
 * Changing one needs templates.manage.
 */
export function createTemplateRoutes(
  options: TemplateOptions & PreviewOptions = {},
): readonly ApiRoute[] {
  const commands = createTemplateCommands(options);
  const preview = {
    endpoint: previewMessageTemplateText,
    run({ invocation, body }) {
      requireBusiness(invocation.context);
      const { subject, body: text, values } = parseInput(previewMessageTemplateInput, body);
      return Promise.resolve(previewMessageTemplate({ subject, body: text }, values));
    },
  } satisfies Route<typeof previewMessageTemplateText>;
  // Reads a contact's own values, as reading the contact does; nothing is saved or sent.
  const render = {
    endpoint: renderEmailPreview,
    run({ invocation, body }, { db }) {
      requireBusiness(invocation.context);
      const input = parseInput(renderEmailPreviewInput, body);
      return withTenant(db, invocation.context, (trx) =>
        readEmailPreview(trx, invocation, input, options),
      );
    },
  } satisfies Route<typeof renderEmailPreview>;
  const list = {
    endpoint: listMessageTemplates,
    run({ invocation, query }, { db }) {
      requireBusiness(invocation.context);
      const parsed = parseInput(listMessageTemplates.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readTemplates(trx, invocation, parsed, options),
      );
    },
  } satisfies Route<typeof listMessageTemplates>;
  const read = {
    endpoint: getMessageTemplate,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const { id } = parseInput(getMessageTemplate.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readTemplate(trx, invocation, id, options),
      );
    },
  } satisfies Route<typeof getMessageTemplate>;
  const create = {
    endpoint: createMessageTemplate,
    command: commands.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, commands.create, body, invocation),
  } satisfies Route<typeof createMessageTemplate>;
  // Each change parses its path first, so an id that isn't a template's is refused as
  // one, whatever the body holds. The command then checks the permission before it looks.
  const update = {
    endpoint: updateMessageTemplate,
    command: commands.update,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(updateMessageTemplate.params, params);
      return runCommand(
        services,
        commands.update,
        { ...parseInput(updateMessageTemplate.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof updateMessageTemplate>;
  const archive = {
    endpoint: archiveMessageTemplate,
    command: commands.archive,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(archiveMessageTemplate.params, params);
      return runCommand(
        services,
        commands.archive,
        { ...parseInput(archiveMessageTemplate.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof archiveMessageTemplate>;
  const restore = {
    endpoint: restoreMessageTemplate,
    command: commands.restore,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(restoreMessageTemplate.params, params);
      return runCommand(
        services,
        commands.restore,
        { ...parseInput(restoreMessageTemplate.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof restoreMessageTemplate>;
  const remove = {
    endpoint: deleteMessageTemplate,
    command: commands.remove,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(deleteMessageTemplate.params, params);
      return runCommand(
        services,
        commands.remove,
        { ...parseInput(deleteMessageTemplate.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof deleteMessageTemplate>;
  const duplicate = {
    endpoint: duplicateMessageTemplate,
    command: commands.duplicate,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(duplicateMessageTemplate.params, params);
      // Every field is optional, so a request may send no body at all.
      return runCommand(
        services,
        commands.duplicate,
        { ...parseInput(duplicateMessageTemplate.body, body ?? {}), id },
        invocation,
      );
    },
  } satisfies Route<typeof duplicateMessageTemplate>;
  const bulk = {
    endpoint: bulkMessageTemplates,
    command: commands.bulk,
    run: ({ invocation, body }, services) => runCommand(services, commands.bulk, body, invocation),
  } satisfies Route<typeof bulkMessageTemplates>;
  return [
    preview,
    render,
    list,
    read,
    create,
    update,
    archive,
    restore,
    remove,
    duplicate,
    bulk,
    ...createTemplateFolderRoutes(options),
  ];
}
