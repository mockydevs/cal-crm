// The manual actions queue over the API. Reading and working it is for a role that works
// conversations: one that manages them, or one that replies. Each list says what the reader
// may do.
import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  assignManualAction,
  completeManualAction,
  getManualAction,
  listManualActions,
  parseInput,
  skipManualAction,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';

import {
  createManualActionCommands,
  manualActionPermission,
  readManualAction,
  readManualActions,
  type ManualActionOptions,
} from './manual-actions.js';

export function createManualActionRoutes(options: ManualActionOptions): readonly ApiRoute[] {
  const asManager = createManualActionCommands(options, 'conversations.manage');
  const asReplier = createManualActionCommands(options, 'conversations.reply');
  // Someone who replies but doesn't manage runs the same command under their own
  // permission; anyone else is held to, and told about, the right to manage.
  const commandsFor = (invocation: Parameters<typeof manualActionPermission>[0]) =>
    manualActionPermission(invocation) === 'conversations.reply' ? asReplier : asManager;
  const requireWork = (invocation: Parameters<typeof manualActionPermission>[0]): void => {
    requireBusiness(invocation.context);
    const permission = manualActionPermission(invocation);
    if (invocation.permissions !== 'all' && !invocation.permissions.has(permission))
      throw new ForbiddenError('You need permission to work conversations.');
  };
  return [
    {
      endpoint: listManualActions,
      run({ invocation, query }, { db }) {
        requireWork(invocation);
        const parsed = parseInput(listManualActions.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readManualActions(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listManualActions>,
    {
      endpoint: getManualAction,
      run({ invocation, params }, { db }) {
        requireWork(invocation);
        const { actionId } = parseInput(getManualAction.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readManualAction(trx, invocation, actionId, options),
        );
      },
    } satisfies Route<typeof getManualAction>,
    {
      endpoint: assignManualAction,
      command: asManager.assign,
      run({ invocation, params, body }, services) {
        const parsed = parseInput(assignManualAction.params, params);
        return runCommand(
          services,
          commandsFor(invocation).assign,
          { ...parseInput(assignManualAction.body, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof assignManualAction>,
    {
      endpoint: completeManualAction,
      command: asManager.complete,
      run({ invocation, params, body }, services) {
        const parsed = parseInput(completeManualAction.params, params);
        return runCommand(
          services,
          commandsFor(invocation).complete,
          { ...parseInput(completeManualAction.body, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof completeManualAction>,
    {
      endpoint: skipManualAction,
      command: asManager.skip,
      run({ invocation, params, body }, services) {
        const parsed = parseInput(skipManualAction.params, params);
        return runCommand(
          services,
          commandsFor(invocation).skip,
          { ...parseInput(skipManualAction.body, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof skipManualAction>,
  ];
}
