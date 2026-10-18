import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  getTagConfiguration,
  updateTagRules,
  updateTag,
  updateTagInput,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { canConfigureTags, canDesignTags } from './access.js';
import { readTagGroups } from './groups.js';
import { readTagDefinitions, updateTagCommand } from './definitions.js';
import { readTagRules, updateTagRulesCommand } from './rules.js';

export const tagConfigurationRoutes: readonly ApiRoute[] = [
  {
    endpoint: getTagConfiguration,
    run: async ({ invocation }, { db }) => {
      requireBusiness(invocation.context);
      return withTenant(db, invocation.context, async (trx) => {
        const rules = await readTagRules(trx);
        const canManage = canConfigureTags(invocation);
        const canCreate =
          canDesignTags(invocation) &&
          (invocation.permissions === 'all' || invocation.permissions.has('tags.manage')) &&
          (rules.creation === 'everyone' || canManage);
        return {
          items: await readTagDefinitions(trx),
          groups: (await readTagGroups(trx, invocation)).items,
          rules,
          canManage,
          canCreate,
        };
      });
    },
  } satisfies Route<typeof getTagConfiguration>,
  {
    endpoint: updateTagRules,
    command: updateTagRulesCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, updateTagRulesCommand, body, invocation),
  } satisfies Route<typeof updateTagRules>,
  {
    endpoint: updateTag,
    command: updateTagCommand,
    run: async ({ invocation, params, body }, services) => {
      requireBusiness(invocation.context);
      const parsed = parseInput(updateTag.params, params);
      await withTenant(services.db, invocation.context, async (trx) => {
        const tag = await trx
          .selectFrom('crm.tags')
          .select('id')
          .where('id', '=', parsePublicId('tag', parsed.id) ?? '')
          .executeTakeFirst();
        if (tag === undefined) throw new NotFoundError('Tag', parsed.id);
      });
      return runCommand(
        services,
        updateTagCommand,
        { ...parseInput(updateTagInput, body), ...parsed },
        invocation,
      );
    },
  } satisfies Route<typeof updateTag>,
];
