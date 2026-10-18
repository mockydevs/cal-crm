import { requireRecord } from '../records/access.js';
import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  getRecordTags,
  assignRecordTag,
  assignRecordTagInput,
  removeRecordTag,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  assignRecordTagCommand,
  readRecordTags,
  removeRecordTagCommand,
  requireExistingTag,
} from './assignments.js';

export const recordTagRoutes: readonly ApiRoute[] = [
  {
    endpoint: getRecordTags,
    run: async ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getRecordTags.params, params);
      return withTenant(db, invocation.context, (trx) => readRecordTags(trx, invocation, id));
    },
  } satisfies Route<typeof getRecordTags>,
  {
    endpoint: assignRecordTag,
    command: assignRecordTagCommand,
    run: async ({ invocation, params, body }, services) => {
      requireBusiness(invocation.context);
      const parsed = parseInput(assignRecordTag.params, params);
      await withTenant(services.db, invocation.context, async (trx) => {
        await requireRecord(trx, parsed.id);
        await requireExistingTag(trx, parsed.tagId);
      });
      return runCommand(
        services,
        assignRecordTagCommand,
        { ...parseInput(assignRecordTagInput, body), ...parsed },
        invocation,
      );
    },
  } satisfies Route<typeof assignRecordTag>,
  {
    endpoint: removeRecordTag,
    command: removeRecordTagCommand,
    run: async ({ invocation, params }, services) => {
      requireBusiness(invocation.context);
      await runCommand(
        services,
        removeRecordTagCommand,
        parseInput(removeRecordTag.params, params),
        invocation,
      );
      return undefined;
    },
  } satisfies Route<typeof removeRecordTag>,
];
