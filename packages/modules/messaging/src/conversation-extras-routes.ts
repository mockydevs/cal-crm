// Snippets and trigger links over the API. Reading either needs no permission beyond being
// in the business, as reading message templates does; each list says whether the reader may
// change it. Changing one needs templates.manage, and filling a snippet in for a contact
// needs conversations.reply.
import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createSnippet,
  createSnippetFolder,
  createTriggerLink,
  deleteSnippet,
  deleteSnippetFolder,
  deleteTriggerLink,
  getSnippet,
  getTriggerLink,
  listSnippetFolders,
  listSnippets,
  listTriggerLinkClicks,
  listTriggerLinks,
  moveSnippets,
  parseInput,
  renameSnippetFolder,
  renderSnippet,
  updateSnippet,
  updateTriggerLink,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import {
  createRenderSnippetCommand,
  createSnippetCommand,
  createSnippetFolderCommand,
  deleteSnippetCommand,
  deleteSnippetFolderCommand,
  moveSnippetsCommand,
  readSnippet,
  readSnippetFolders,
  readSnippets,
  renameSnippetFolderCommand,
  updateSnippetCommand,
  type SnippetOptions,
} from './snippets.js';
import {
  createTriggerLinkCommand,
  deleteTriggerLinkCommand,
  readTriggerLink,
  readTriggerLinkClicks,
  readTriggerLinks,
  updateTriggerLinkCommand,
} from './trigger-links.js';

/** The snippet routes, made with what fills a snippet in for a contact. */
export function createSnippetRoutes(options: SnippetOptions): readonly ApiRoute[] {
  const render = createRenderSnippetCommand(options);
  return [
    {
      endpoint: listSnippets,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const parsed = parseInput(listSnippets.query, query);
        return withTenant(db, invocation.context, (trx) => readSnippets(trx, invocation, parsed));
      },
    } satisfies Route<typeof listSnippets>,
    {
      endpoint: getSnippet,
      run({ invocation, params }, { db }) {
        requireBusiness(invocation.context);
        const { snippetId } = parseInput(getSnippet.params, params);
        return withTenant(db, invocation.context, (trx) => readSnippet(trx, invocation, snippetId));
      },
    } satisfies Route<typeof getSnippet>,
    {
      endpoint: createSnippet,
      command: createSnippetCommand,
      run: ({ invocation, body }, services) =>
        runCommand(services, createSnippetCommand, body, invocation),
    } satisfies Route<typeof createSnippet>,
    {
      endpoint: moveSnippets,
      command: moveSnippetsCommand,
      run: ({ invocation, body }, services) =>
        runCommand(services, moveSnippetsCommand, body, invocation),
    } satisfies Route<typeof moveSnippets>,
    // Each change parses its path first, so an id that isn't a snippet's is refused as
    // one, whatever the body holds. The command then checks the permission before it looks.
    {
      endpoint: updateSnippet,
      command: updateSnippetCommand,
      run({ invocation, params, body }, services) {
        const parsed = parseInput(updateSnippet.params, params);
        return runCommand(
          services,
          updateSnippetCommand,
          { ...parseInput(updateSnippet.body, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof updateSnippet>,
    {
      endpoint: deleteSnippet,
      command: deleteSnippetCommand,
      async run({ invocation, params }, services) {
        const parsed = parseInput(deleteSnippet.params, params);
        await runCommand(services, deleteSnippetCommand, parsed, invocation);
        return undefined;
      },
    } satisfies Route<typeof deleteSnippet>,
    {
      endpoint: renderSnippet,
      command: render,
      run({ invocation, params, body }, services) {
        const parsed = parseInput(renderSnippet.params, params);
        return runCommand(
          services,
          render,
          { ...parseInput(renderSnippet.body, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof renderSnippet>,
    {
      endpoint: listSnippetFolders,
      run({ invocation }, { db }) {
        requireBusiness(invocation.context);
        return withTenant(db, invocation.context, (trx) => readSnippetFolders(trx, invocation));
      },
    } satisfies Route<typeof listSnippetFolders>,
    {
      endpoint: createSnippetFolder,
      command: createSnippetFolderCommand,
      run: ({ invocation, body }, services) =>
        runCommand(services, createSnippetFolderCommand, body, invocation),
    } satisfies Route<typeof createSnippetFolder>,
    {
      endpoint: renameSnippetFolder,
      command: renameSnippetFolderCommand,
      run({ invocation, params, body }, services) {
        const parsed = parseInput(renameSnippetFolder.params, params);
        return runCommand(
          services,
          renameSnippetFolderCommand,
          { ...parseInput(renameSnippetFolder.body, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof renameSnippetFolder>,
    {
      endpoint: deleteSnippetFolder,
      command: deleteSnippetFolderCommand,
      async run({ invocation, params }, services) {
        const parsed = parseInput(deleteSnippetFolder.params, params);
        await runCommand(services, deleteSnippetFolderCommand, parsed, invocation);
        return undefined;
      },
    } satisfies Route<typeof deleteSnippetFolder>,
  ];
}

export const triggerLinkRoutes: readonly ApiRoute[] = [
  {
    endpoint: listTriggerLinks,
    run({ invocation, query }, { db }) {
      requireBusiness(invocation.context);
      const parsed = parseInput(listTriggerLinks.query, query);
      return withTenant(db, invocation.context, (trx) => readTriggerLinks(trx, invocation, parsed));
    },
  } satisfies Route<typeof listTriggerLinks>,
  {
    endpoint: getTriggerLink,
    run({ invocation, params }, { db }) {
      requireBusiness(invocation.context);
      const { linkId } = parseInput(getTriggerLink.params, params);
      return withTenant(db, invocation.context, (trx) => readTriggerLink(trx, invocation, linkId));
    },
  } satisfies Route<typeof getTriggerLink>,
  {
    endpoint: createTriggerLink,
    command: createTriggerLinkCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createTriggerLinkCommand, body, invocation),
  } satisfies Route<typeof createTriggerLink>,
  {
    endpoint: updateTriggerLink,
    command: updateTriggerLinkCommand,
    run({ invocation, params, body }, services) {
      const parsed = parseInput(updateTriggerLink.params, params);
      return runCommand(
        services,
        updateTriggerLinkCommand,
        { ...parseInput(updateTriggerLink.body, body), ...parsed },
        invocation,
      );
    },
  } satisfies Route<typeof updateTriggerLink>,
  {
    endpoint: deleteTriggerLink,
    command: deleteTriggerLinkCommand,
    async run({ invocation, params }, services) {
      const parsed = parseInput(deleteTriggerLink.params, params);
      await runCommand(services, deleteTriggerLinkCommand, parsed, invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteTriggerLink>,
  {
    endpoint: listTriggerLinkClicks,
    run({ invocation, params, query }, { db }) {
      requireBusiness(invocation.context);
      const { linkId } = parseInput(listTriggerLinkClicks.params, params);
      const parsed = parseInput(listTriggerLinkClicks.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readTriggerLinkClicks(trx, invocation, linkId, parsed),
      );
    },
  } satisfies Route<typeof listTriggerLinkClicks>,
];
