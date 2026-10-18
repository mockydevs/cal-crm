import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createView,
  createViewInput,
  contactViewChanges,
  dealViewChanges,
  deleteView,
  deleteViewInput,
  listViews,
  setViewSharing,
  shareView,
  shareViewInput,
  unshareView,
  unshareViewInput,
  updateView,
  viewSharingInput,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import type { ActorNames } from '../activity/activity.js';
import {
  createViewCommand,
  deleteViewCommand,
  readViews,
  requireView,
  sharingCommand,
  updateViewCommand,
  visibilityCommand,
  type ViewPeople,
} from './views.js';

export function viewRoutes(actorNames: ActorNames, people?: ViewPeople): readonly ApiRoute[] {
  const create = createViewCommand(actorNames, people);
  const update = updateViewCommand(actorNames, people);
  const share = visibilityCommand(actorNames, 'shared', people);
  const unshare = visibilityCommand(actorNames, 'private', people);
  const sharing = sharingCommand(actorNames, people);
  return [
    {
      endpoint: listViews,
      run({ invocation, query }, { db }) {
        requireBusiness(invocation.context);
        const parsed = parseInput(listViews.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readViews(trx, invocation, parsed.object, actorNames, people),
        );
      },
    } satisfies Route<typeof listViews>,
    {
      endpoint: setViewSharing,
      command: sharing,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(setViewSharing.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireView(trx, parsed.id));
        return runCommand(
          services,
          sharing,
          { ...parseInput(viewSharingInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof setViewSharing>,
    {
      endpoint: createView,
      command: create,
      run({ invocation, body }, services) {
        requireBusiness(invocation.context);
        return runCommand(services, create, parseInput(createViewInput, body), invocation);
      },
    } satisfies Route<typeof createView>,
    {
      endpoint: shareView,
      command: share,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(shareView.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireView(trx, parsed.id));
        return runCommand(
          services,
          share,
          { ...parseInput(shareViewInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof shareView>,
    {
      endpoint: unshareView,
      command: unshare,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(unshareView.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireView(trx, parsed.id));
        return runCommand(
          services,
          unshare,
          { ...parseInput(unshareViewInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof unshareView>,
    {
      endpoint: updateView,
      command: update,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(updateView.params, params);
        const current = await withTenant(services.db, invocation.context, (trx) =>
          requireView(trx, parsed.id),
        );
        const input = parseInput(
          current.object_key === 'contact' ? contactViewChanges : dealViewChanges,
          body,
        );
        return runCommand(services, update, { ...input, ...parsed }, invocation);
      },
    } satisfies Route<typeof updateView>,
    {
      endpoint: deleteView,
      command: deleteViewCommand,
      async run({ invocation, params, body }, services) {
        requireBusiness(invocation.context);
        const parsed = parseInput(deleteView.params, params);
        await withTenant(services.db, invocation.context, (trx) => requireView(trx, parsed.id));
        return runCommand(
          services,
          deleteViewCommand,
          { ...parseInput(deleteViewInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof deleteView>,
  ];
}
