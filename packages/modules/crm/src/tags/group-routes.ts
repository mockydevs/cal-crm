import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  getTagGroups,
  createTagGroup,
  updateTagGroup,
  updateTagGroupInput,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { createTagGroupCommand, readTagGroups, updateTagGroupCommand } from './groups.js';

export const tagGroupRoutes: readonly ApiRoute[] = [
  {
    endpoint: getTagGroups,
    run: async ({ invocation }, { db }) => {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, (trx) => readTagGroups(trx, invocation));
    },
  } satisfies Route<typeof getTagGroups>,
  {
    endpoint: createTagGroup,
    command: createTagGroupCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createTagGroupCommand, body, invocation),
  } satisfies Route<typeof createTagGroup>,
  {
    endpoint: updateTagGroup,
    command: updateTagGroupCommand,
    run: async ({ invocation, params, body }, services) => {
      requireBusiness(invocation.context);
      const parsed = parseInput(updateTagGroup.params, params);
      await withTenant(services.db, invocation.context, async (trx) => {
        const group = await trx
          .selectFrom('crm.tag_groups')
          .select('id')
          .where('id', '=', parsePublicId('tag_group', parsed.groupId) ?? '')
          .executeTakeFirst();
        if (group === undefined) throw new NotFoundError('Tag group', parsed.groupId);
      });
      return runCommand(
        services,
        updateTagGroupCommand,
        { ...parseInput(updateTagGroupInput, body), ...parsed },
        invocation,
      );
    },
  } satisfies Route<typeof updateTagGroup>,
];
